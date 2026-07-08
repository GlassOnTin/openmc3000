import { buildFrame, be16, REPORT_SIZE } from "./frame.ts";

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
  /** Bytes 22-23. Matches U·I while charging/discharging; in standby it reads a stale
   *  non-zero value (meaning unknown). Trust only when statusRaw is 1 or 2. */
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

/**
 * Build a SET_PROGRAM (0x11) frame that writes a slot's program back with optional
 * field overrides. `readReply` is a 0x5F SLOT_PROGRAM reply for that slot; the write
 * frame is a repack of it (the write layout differs from the read layout). Verified on
 * firmware 1.25 by identity-write + single-field round-trip; layout from DataExplorer
 * MC3000.java getBuffer() (firmware > 1.11 branch). NOT valid for firmware ≤ 1.11.
 *
 * Overrides are in the same units the device reports (mA, mV).
 */
export function buildSetProgram(
  readReply: Uint8Array,
  slot: number,
  o: { chargeCurrentMa?: number; dischargeCurrentMa?: number } = {},
): Uint8Array {
  const rb = readReply;
  const w = new Uint8Array(REPORT_SIZE);
  w.set([0x0f, 0x20, 0x11, 0x00, slot, rb[3]]);
  w[6] = rb[5]; w[7] = rb[6];        // capacity
  w[8] = rb[4];                      // operation mode
  w.set(rb.subarray(7, 21), 9);      // charge current .. charge resting (14 bytes)
  w[23] = rb[31];                    // discharge resting time
  w[24] = rb[21];                    // cycle mode
  w[25] = rb[22];                    // peak sense voltage
  w[26] = rb[23];                    // trickle current
  w[27] = rb[30];                    // trickle time
  w[28] = rb[26];                    // cut temperature
  w[29] = rb[27]; w[30] = rb[28];    // cut time
  w[31] = rb[24]; w[32] = rb[25];    // restart voltage
  if (o.chargeCurrentMa !== undefined) { w[9] = o.chargeCurrentMa >> 8; w[10] = o.chargeCurrentMa & 0xff; }
  if (o.dischargeCurrentMa !== undefined) { w[11] = o.dischargeCurrentMa >> 8; w[12] = o.dischargeCurrentMa & 0xff; }
  let sum = 0;                       // checksum = sum(w[2..32]) inclusive
  for (let i = 2; i <= 32; i++) sum += w[i];
  w[33] = sum & 0xff;
  w[34] = 0xff; w[35] = 0xff;
  return w;
}

/** SET_PROGRAM acks with a report whose first byte is 0xF0. */
export const isSetProgramAck = (r: Uint8Array): boolean => r[0] === 0xf0;

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
