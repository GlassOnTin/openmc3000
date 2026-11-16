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
 *   HIDRAW_PATH     optional explicit /dev/hidrawN path
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
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHARGE_MAX_MA, METRICS, discoveryConfig, numberConfig, stateJson, switchConfig, slotSwitchConfig } from "./payload.ts";

const MQTT_URL = process.env.MQTT_URL;
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const PREFIX = process.env.DISCOVERY_PREFIX ?? "homeassistant";
const readOnly = process.env.READ_ONLY === "1";
const bleAddress = process.env.BLE_ADDRESS ?? "";
if (bleAddress && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(bleAddress)) throw new Error("Invalid BLE_ADDRESS");
const bleScript = fileURLToPath(new URL("./ble_command.py", import.meta.url));
const dry = !MQTT_URL;

async function main() {
  const t: Transport = new HidrawTransport(process.env.HIDRAW_PATH);

  // Serialize ALL device I/O — the poll interval and async command handlers share one transport.
  let lock: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };

  let running: boolean | undefined; // undefined until every slot was read successfully
  let runGeneration = 0;
  let bleStopGeneration = 0;
  let bleStartProcess: ChildProcess | undefined;
  let bleProcess: ChildProcess | undefined;
  let shuttingDown = false;
  let commands = Promise.resolve();
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
      username: process.env.MQTT_USERNAME || undefined, password: process.env.MQTT_PASSWORD || undefined,
      will: { topic: availTopic, payload: "offline", retain: true, qos: 0 },
    });
    await new Promise<void>((res, rej) => { client.once("connect", () => res()); client.once("error", rej); });
    console.log("connected to broker");
    publish = (topic, payload, retain = false) => { client.publish(topic, payload, { retain, qos: 0 }); };
    subscribe = (topic, cb) => {
      client.subscribe(topic);
      client.on("message", (tp, pl, packet) => {
        if (packet.retain) return console.error(`ignored retained command on ${tp}`);
        cb(tp, pl.toString());
      });
    };
    close = () => new Promise((res) => client.end(false, {}, () => res(undefined)));
  }

  // --- discovery: sensors + (unless read-only) switch & numbers ------------
  for (let s = 1; s <= 4; s++)
    for (const m of METRICS)
      publish(`${PREFIX}/sensor/${id}/s${s}_${m.key}/config`, JSON.stringify(discoveryConfig(m, s, id, base, availTopic, device)), true);
  let subscribeCommands = () => {};
  if (!readOnly) {
    publish(`${PREFIX}/switch/${id}/run/config`, JSON.stringify(switchConfig(id, base, availTopic, device)), true);
    for (let s = 1; s <= 4; s++)
      publish(`${PREFIX}/number/${id}/s${s}_charge_current/config`, JSON.stringify(numberConfig(s, id, base, availTopic, device)), true);
  } else {
    publish(`${PREFIX}/switch/${id}/run/config`, "", true);
    for (let s = 1; s <= 4; s++)
      publish(`${PREFIX}/number/${id}/s${s}_charge_current/config`, "", true);
  }
  for (let s = 1; s <= 4; s++)
    publish(`${PREFIX}/switch/${id}/s${s}_run/config`,
      !readOnly && bleAddress ? JSON.stringify(slotSwitchConfig(s, id, base, availTopic, device)) : "", true);

  // publish current charge-current setpoints (read the slot programs once)
  const publishSetpoint = async (slot: number) => {
    const r = await withLock(() => request(t, readSlotProgram(slot)));
    if (!checkReply(r)) throw new Error("bad program reply checksum");
    publish(`${base}/set/slot${slot + 1}/charge_current`, String(parseSlotProgram(r).chargeCurrentMa), true);
  };
  for (let s = 0; s < 4; s++) {
    try { await publishSetpoint(s); }
    catch (e) { console.error(`slot ${s + 1} program read failed:`, (e as Error).message); }
  }
  // --- command handling -----------------------------------------------------
  if (!readOnly) {
    const handle = async (topic: string, payload: string, commandGeneration: number) => {
      try {
        if (shuttingDown) return;
        if (topic === `${base}/cmd/run`) {
          const value = payload.trim().toUpperCase();
          if (value !== "ON" && value !== "OFF") return console.error(`bad run command: ${payload}`);
          const on = value === "ON";
          if (on && running === undefined) return console.error("START rejected: charger state is unknown");
          runGeneration++;
          // START is ignored while a slot is latched (seen right after a program
          // write) — a STOP first clears it. Only when nothing is already running,
          // so we never interrupt a charge in progress.
          if (on && !running) { await withLock(() => t.send(stop())); await new Promise((r) => setTimeout(r, 250)); }
          await withLock(() => t.send(on ? start() : stop()));   // global; no reply
          running = on ? true : undefined;
          console.log(`command: ${on ? "START" : "STOP"} (all)`);
        } else if (bleAddress && /^mc3000\/[^/]+\/cmd\/slot[1-4]\/run$/.test(topic)) {
          const m = topic.match(new RegExp(`^${base}/cmd/slot([1-4])/run$`));
          if (!m) return;
          const value = payload.trim().toUpperCase();
          if (value !== "ON" && value !== "OFF") return console.error(`bad slot run command: ${payload}`);
          const slot = Number(m[1]);
          if (value === "ON" && commandGeneration !== bleStopGeneration) return console.error("START cancelled by STOP");
          if (value === "ON" && running === undefined) return console.error("START rejected: USB charger state is unknown");
          runGeneration++;
          await withLock(() => new Promise<void>((resolve, reject) => {
            if (shuttingDown) return reject(new Error("Bridge is shutting down"));
            if (value === "ON" && commandGeneration !== bleStopGeneration) return reject(new Error("START cancelled by STOP"));
            const child = execFile(process.env.BLE_PYTHON || "python3", [bleScript, bleAddress, String(slot), value],
              { timeout: 35000 }, (error, _stdout, stderr) => {
                if (bleStartProcess === child) bleStartProcess = undefined;
                if (bleProcess === child) bleProcess = undefined;
                if (error) reject(new Error(`BLE command failed; outcome may be unknown: ${stderr || error.message}`));
                else resolve();
              });
            bleProcess = child;
            if (value === "ON") bleStartProcess = child;
          }));
          console.log(`command: slot ${slot} ${value} confirmed over BLE`);
        } else {
          const m = topic.match(new RegExp(`^${base}/cmd/slot([1-4])/charge_current$`));
          if (!m) return;
          const slot = Number(m[1]) - 1;
          if (!payload.trim()) return console.error("bad charge current: empty payload");
          const val = Math.round(Number(payload));
          if (!Number.isFinite(val) || val < 0 || val > CHARGE_MAX_MA) return console.error(`bad charge current: ${payload}`);
          const rp = await withLock(() => request(t, readSlotProgram(slot)));
          if (!checkReply(rp)) return console.error(`slot ${slot + 1} program reply has a bad checksum`);
          const ack = await withLock(() => request(t, buildSetProgram(rp, slot, { chargeCurrentMa: val })));
          if (!isSetProgramAck(ack)) return console.error(`slot ${slot + 1} charge-current write rejected`);
          await publishSetpoint(slot);
          console.log(`command: slot ${slot + 1} charge current → ${val} mA`);
        }
      } catch (e) {
        console.error("command failed:", (e as Error).message);
      }
    };
    subscribeCommands = () => subscribe(`${base}/cmd/#`, (topic, payload) => {
      if (shuttingDown) return;
      if (bleAddress && /^mc3000\/[^/]+\/cmd\/slot[1-4]\/run$/.test(topic) && payload.trim().toUpperCase() === "OFF") {
        bleStopGeneration++;
        bleStartProcess?.kill();
      }
      const generation = bleStopGeneration;
      commands = commands.then(() => handle(topic, payload, generation));
    });
  }

  // --- poll loop ------------------------------------------------------------
  const poll = async () => {
    const generation = runGeneration;
    running = undefined;
    let anyRunning = false;
    let complete = true;
    for (let s = 0; s < 4; s++) {
      try {
        const reply = await withLock(() => request(t, readLive(s)));
        if (!checkReply(reply)) {
          complete = false;
          console.error(`slot ${s + 1} reply has a bad checksum`);
          continue;
        }
        const l = parseLive(reply);
        if ([1, 2, 3].includes(l.statusRaw)) anyRunning = true;
        publish(`${base}/slot${s + 1}`, JSON.stringify(stateJson(l)));
        if (!readOnly && bleAddress && (l.statusRaw <= 4 || l.statusRaw >= 0x80))
          publish(`${base}/slot${s + 1}/run`, [1, 2, 3].includes(l.statusRaw) ? "ON" : "OFF");
      } catch (e) {
        complete = false;
        console.error(`slot ${s + 1} read failed:`, (e as Error).message);
      }
    }
    running = complete && generation === runGeneration ? anyRunning : undefined;
    publish(availTopic, complete ? "online" : "offline", true);
    if (running !== undefined) publish(`${base}/run`, anyRunning ? "ON" : "OFF");
  };
  await poll();
  subscribeCommands();
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { await poll(); } finally { polling = false; }
  }, POLL_MS);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);
    bleProcess?.kill();
    await commands;
    publish(availTopic, "offline", true);
    await close();
    await withLock(() => t.close());
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });
