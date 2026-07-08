import { buildFrame, be16 } from "./frame.ts";

export const Cmd = {
  START: 0x05,        // begin the program loaded in each slot. No reply.
  LIVE: 0x55,         // per-slot live telemetry
  SYSTEM: 0x5a,       // system settings
  SLOT_PROGRAM: 0x5f, // per-slot program (battery type, currents, cutoffs)
  SET_PROGRAM: 0x11,  // write a slot program; device acks with 0xF0
  STOP: 0xfe,         // halt all slots. No reply.
} as const;

export const BATTERY_TYPES = [
  "LiIon", "LiFe", "LiIo4.35", "NiMH", "NiCd", "NiZn", "Eneloop", "RAM",
] as const;

/** buf[5] of a LIVE reply. 0x80+ are error codes. */
export const STATUS = ["standby", "charge", "discharge", "resting", "finish"] as const;

export const readLive = (slot: number) => buildFrame(Cmd.LIVE, [0x00, slot]);
export const readSlotProgram = (slot: number) => buildFrame(Cmd.SLOT_PROGRAM, [0x00, slot]);
export const readSystem = () => buildFrame(Cmd.SYSTEM, [0x00, 0x00]);

/**
 * START and STOP take a single 0x00 data byte and elicit **no reply** — the
 * charger acts silently. Poll LIVE to observe the state change.
 *
 * DataExplorer 4.0.6 declares both opcodes but leaves the calls commented out
 * (SkyRC/src/gde/device/skyrc/MC3000UsbPort.java:183-230); they work.
 */
export const start = () => buildFrame(Cmd.START, [0x00]);
export const stop = () => buildFrame(Cmd.STOP, [0x00]);

export interface Live {
  slot: number;
  batteryType: string;
  mode: number;
  status: string;
  statusRaw: number;
  voltageMv: number;
  currentMa: number;
  capacityMah: number;
  powerMw: number;
  /** Raw temperature word. ≈0.1 °C (304 → 30.4 °C), scale not independently confirmed. */
  temperatureRaw: number;
}

/**
 * Offsets cross-checked against DataExplorer's MC3000.convertDataBytes() and
 * verified against firmware 1.25. voltage/current/capacity/status and powerMw are
 * verified; powerMw (firmware ≥ 1.05) read 3015 mW at 3.646 V × 826 mA.
 * The caller must have drained the input queue — an undrained read is one report stale.
 */
export function parseLive(r: Uint8Array): Live {
  const statusRaw = r[5];
  return {
    slot: r[1],
    batteryType: BATTERY_TYPES[r[2]] ?? `unknown(${r[2]})`,
    mode: r[3],
    statusRaw,
    status: STATUS[statusRaw] ?? `error(0x${statusRaw.toString(16)})`,
    voltageMv: be16(r, 8),
    currentMa: be16(r, 10),
    capacityMah: be16(r, 12),
    temperatureRaw: be16(r, 14),
    powerMw: be16(r, 22),
  };
}

export interface System {
  serial: string;
  firmware: string;
  hardware: string;
}

/** Machine-id block starts at offset 16 of the SYSTEM (0x5A) reply. Verified on fw 1.25. */
export function parseSystem(r: Uint8Array): System {
  const mid = r.subarray(16, 32);
  const serial = String.fromCharCode(...mid.subarray(0, 6)).replace(/[^\x20-\x7e]/g, "");
  return {
    serial,
    firmware: `${mid[11]}.${String(mid[12]).padStart(2, "0")}`,
    hardware: `${Math.floor(mid[13] / 10)}.${mid[13] % 10}`,
  };
}
