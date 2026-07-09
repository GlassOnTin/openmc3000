// Pure MQTT / Home Assistant payload construction — no I/O, so it's testable without
// a charger or a broker. bridge.ts wires these to the transport and the MQTT client.
import type { Live } from "../src/protocol/commands.ts";

export type Metric = { key: string; name: string; unit?: string; dc?: string; sc?: string; val: (l: Live) => string | number };

export const METRICS: Metric[] = [
  { key: "voltage", name: "Voltage", unit: "V", dc: "voltage", val: (l) => (l.voltageMv / 1000).toFixed(3) },
  { key: "current", name: "Current", unit: "A", dc: "current", val: (l) => (l.currentMa / 1000).toFixed(3) },
  { key: "capacity", name: "Capacity", unit: "mAh", sc: "total_increasing", val: (l) => l.capacityMah },
  // power as V·I so it reads 0 at idle (the device's power field is stale in standby)
  { key: "power", name: "Power", unit: "W", dc: "power", val: (l) => (l.voltageMv / 1000 * l.currentMa / 1000).toFixed(2) },
  { key: "energy", name: "Energy", unit: "Wh", dc: "energy", sc: "total_increasing", val: (l) => (l.energyMwh / 1000).toFixed(3) },
  { key: "temperature", name: "Temperature", unit: "°C", dc: "temperature", val: (l) => (l.temperatureRaw / 10).toFixed(1) },
  { key: "resistance", name: "Internal resistance", unit: "mΩ", val: (l) => l.resistanceMOhm },
  { key: "status", name: "Status", val: (l) => l.status },
];

export type Device = { identifiers: string[]; name: string; manufacturer: string; model: string; sw_version: string };

/** One Home Assistant MQTT-discovery sensor config for slot `slot` (1-based), metric `m`. */
export function discoveryConfig(m: Metric, slot: number, id: string, base: string, availTopic: string, device: Device): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    name: `Slot ${slot} ${m.name}`,
    unique_id: `${id}_s${slot}_${m.key}`,
    state_topic: `${base}/slot${slot}`,
    value_template: `{{ value_json.${m.key} }}`,
    availability_topic: availTopic,
    device,
  };
  if (m.unit) cfg.unit_of_measurement = m.unit;
  if (m.dc) cfg.device_class = m.dc;
  if (m.sc) cfg.state_class = m.sc;
  return cfg;
}

/** The per-slot JSON state payload every sensor reads via its value_template. */
export function stateJson(l: Live): Record<string, string | number> {
  const s: Record<string, string | number> = {};
  for (const m of METRICS) s[m.key] = m.val(l);
  return s;
}
