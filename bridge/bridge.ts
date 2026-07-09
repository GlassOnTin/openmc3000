#!/usr/bin/env -S node --experimental-strip-types
/**
 * MQTT / Home Assistant bridge for the SkyRC MC3000.
 *
 * Polls all four slots over USB-HID (reusing the shared codec) and publishes per-slot
 * telemetry to MQTT with Home Assistant auto-discovery. Also exposes control: a Charging
 * switch (global start/stop) and a per-slot charge-current number (via SET_PROGRAM).
 *
 * Config (env):
 *   MQTT_URL        mqtt://host:1883 (or mqtts://…). UNSET → dry-run: log payloads, no broker.
 *   MQTT_USERNAME / MQTT_PASSWORD   optional
 *   POLL_MS         poll interval, default 2000
 *   DISCOVERY_PREFIX  HA discovery prefix, default "homeassistant"
 *   READ_ONLY=1     publish telemetry only; do not subscribe to or act on commands
 *
 * The charger is a single, exclusive USB consumer — run the bridge OR the web app, not both.
 */
import {
  buildSetProgram, isSetProgramAck, parseLive, parseSlotProgram, parseSystem,
  readLive, readSlotProgram, readSystem, start, stop,
} from "../src/protocol/commands.ts";
import { checkReply } from "../src/protocol/frame.ts";
import { HidrawTransport } from "../src/transport/hidraw.ts";
import { request, type Transport } from "../src/transport/transport.ts";
import { CHARGE_MAX_MA, METRICS, discoveryConfig, numberConfig, stateJson, switchConfig } from "./payload.ts";

const MQTT_URL = process.env.MQTT_URL;
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const PREFIX = process.env.DISCOVERY_PREFIX ?? "homeassistant";
const readOnly = process.env.READ_ONLY === "1";
const dry = !MQTT_URL;

async function main() {
  const t: Transport = new HidrawTransport();

  // Serialize ALL device I/O — the poll interval and async command handlers share one transport.
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  const sys = parseSystem(await withLock(() => request(t, readSystem())));
  const id = `mc3000_${sys.serial}`;
  const base = `mc3000/${sys.serial}`;
  const availTopic = `${base}/status`;
  const device = { identifiers: [id], name: "SkyRC MC3000", manufacturer: "SkyRC", model: "MC3000", sw_version: sys.firmware };
  console.log(`MC3000 ${sys.serial} fw ${sys.firmware} → ${dry ? "DRY-RUN (no broker)" : MQTT_URL} · ${readOnly ? "read-only" : "control enabled"}`);

  // --- MQTT (lazy import so dry-run needs no dependency) --------------------
  let publish: (topic: string, payload: string, retain?: boolean) => void;
  let subscribe: (topic: string, cb: (topic: string, payload: string) => void) => void = () => {};
  let close = async () => {};
  if (dry) {
    publish = (topic, payload, retain) => console.log(`  ${retain ? "(retain) " : ""}${topic}  ${payload}`);
  } else {
    const mqtt = await import("mqtt");
    const client = mqtt.connect(MQTT_URL!, {
      username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD,
      will: { topic: availTopic, payload: "offline", retain: true, qos: 0 },
    });
    await new Promise<void>((res, rej) => { client.once("connect", () => res()); client.once("error", rej); });
    console.log("connected to broker");
    publish = (topic, payload, retain = false) => { client.publish(topic, payload, { retain, qos: 0 }); };
    subscribe = (topic, cb) => { client.subscribe(topic); client.on("message", (tp, pl) => cb(tp, pl.toString())); };
    close = () => new Promise((res) => client.end(false, {}, () => res(undefined)));
  }

  // --- discovery: sensors + (unless read-only) switch & numbers ------------
  for (let s = 1; s <= 4; s++)
    for (const m of METRICS)
      publish(`${PREFIX}/sensor/${id}/s${s}_${m.key}/config`, JSON.stringify(discoveryConfig(m, s, id, base, availTopic, device)), true);
  if (!readOnly) {
    publish(`${PREFIX}/switch/${id}/run/config`, JSON.stringify(switchConfig(id, base, availTopic, device)), true);
    for (let s = 1; s <= 4; s++)
      publish(`${PREFIX}/number/${id}/s${s}_charge_current/config`, JSON.stringify(numberConfig(s, id, base, availTopic, device)), true);
  }

  // publish current charge-current setpoints (read the slot programs once)
  const publishSetpoint = async (slot: number) => {
    const r = await withLock(() => request(t, readSlotProgram(slot)));
    if (checkReply(r)) publish(`${base}/set/slot${slot + 1}/charge_current`, String(parseSlotProgram(r).chargeCurrentMa), true);
  };
  for (let s = 0; s < 4; s++) await publishSetpoint(s).catch(() => {});
  publish(availTopic, "online", true);

  // --- command handling -----------------------------------------------------
  if (!readOnly) {
    const handle = async (topic: string, payload: string) => {
      try {
        if (topic === `${base}/cmd/run`) {
          const on = payload.trim().toUpperCase() === "ON";
          await withLock(() => t.send(on ? start() : stop()));   // global; no reply
          console.log(`command: ${on ? "START" : "STOP"} (all)`);
        } else {
          const m = topic.match(new RegExp(`^${base}/cmd/slot([1-4])/charge_current$`));
          if (!m) return;
          const slot = Number(m[1]) - 1;
          const val = Math.round(Number(payload));
          if (!Number.isFinite(val) || val < 0 || val > CHARGE_MAX_MA) return console.error(`bad charge current: ${payload}`);
          const rp = await withLock(() => request(t, readSlotProgram(slot)));
          if (!checkReply(rp)) return;
          const ack = await withLock(() => request(t, buildSetProgram(rp, slot, { chargeCurrentMa: val })));
          if (!isSetProgramAck(ack)) return console.error(`slot ${slot + 1} charge-current write rejected`);
          await publishSetpoint(slot);
          console.log(`command: slot ${slot + 1} charge current → ${val} mA`);
        }
      } catch (e) {
        console.error("command failed:", (e as Error).message);
      }
    };
    subscribe(`${base}/cmd/#`, handle);
  }

  // --- poll loop ------------------------------------------------------------
  const poll = async () => {
    let anyRunning = false;
    for (let s = 0; s < 4; s++) {
      try {
        const reply = await withLock(() => request(t, readLive(s)));
        if (!checkReply(reply)) continue;
        const l = parseLive(reply);
        if (l.statusRaw === 1 || l.statusRaw === 2) anyRunning = true;
        publish(`${base}/slot${s + 1}`, JSON.stringify(stateJson(l)));
      } catch (e) {
        console.error(`slot ${s + 1} read failed:`, (e as Error).message);
      }
    }
    publish(`${base}/run`, anyRunning ? "ON" : "OFF");
  };
  await poll();
  const timer = setInterval(poll, POLL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    publish(availTopic, "offline", true);
    await close();
    await t.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
