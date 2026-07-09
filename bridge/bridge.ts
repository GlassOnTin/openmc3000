#!/usr/bin/env -S node --experimental-strip-types
/**
 * MQTT / Home Assistant bridge for the SkyRC MC3000.
 *
 * Polls all four slots over USB-HID (reusing the shared codec) and publishes per-slot
 * telemetry to MQTT with Home Assistant auto-discovery, so HA creates the entities itself.
 *
 * Config (env):
 *   MQTT_URL        mqtt://host:1883  (or mqtts://…). UNSET → dry-run: log payloads, no broker.
 *   MQTT_USERNAME   optional
 *   MQTT_PASSWORD   optional
 *   POLL_MS         poll interval, default 2000
 *   DISCOVERY_PREFIX  HA discovery prefix, default "homeassistant"
 *
 * Read-only: publishes telemetry only. It does not start/stop or change the charger.
 * The charger is a single, exclusive USB consumer — run the bridge OR the web app, not both.
 */
import { parseLive, parseSystem, readLive, readSystem } from "../src/protocol/commands.ts";
import { checkReply } from "../src/protocol/frame.ts";
import { HidrawTransport } from "../src/transport/hidraw.ts";
import { request, type Transport } from "../src/transport/transport.ts";
import { METRICS, discoveryConfig, stateJson } from "./payload.ts";

const MQTT_URL = process.env.MQTT_URL;
const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const PREFIX = process.env.DISCOVERY_PREFIX ?? "homeassistant";
const dry = !MQTT_URL;

async function main() {
  const t: Transport = new HidrawTransport();
  const sys = parseSystem(await request(t, readSystem()));
  const id = `mc3000_${sys.serial}`;
  const base = `mc3000/${sys.serial}`;
  const availTopic = `${base}/status`;
  const device = { identifiers: [id], name: "SkyRC MC3000", manufacturer: "SkyRC", model: "MC3000", sw_version: sys.firmware };
  console.log(`MC3000 ${sys.serial} fw ${sys.firmware} → ${dry ? "DRY-RUN (no broker)" : MQTT_URL} · base topic ${base}`);

  // --- MQTT (lazy import so dry-run needs no dependency) --------------------
  let publish: (topic: string, payload: string, retain?: boolean) => void;
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
    close = () => new Promise((res) => client.end(false, {}, () => res(undefined)));
  }

  // --- HA discovery (retained) ---------------------------------------------
  for (let s = 1; s <= 4; s++)
    for (const m of METRICS)
      publish(`${PREFIX}/sensor/${id}/s${s}_${m.key}/config`, JSON.stringify(discoveryConfig(m, s, id, base, availTopic, device)), true);
  publish(availTopic, "online", true);

  // --- poll loop ------------------------------------------------------------
  const poll = async () => {
    for (let s = 0; s < 4; s++) {
      try {
        const reply = await request(t, readLive(s));
        if (!checkReply(reply)) continue;
        publish(`${base}/slot${s + 1}`, JSON.stringify(stateJson(parseLive(reply))));
      } catch (e) {
        console.error(`slot ${s + 1} read failed:`, (e as Error).message);
      }
    }
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
