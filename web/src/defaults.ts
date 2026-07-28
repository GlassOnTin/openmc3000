// Charge-parameter policy: the values "Reset to defaults" writes, and the safe
// voltage windows the charts are drawn against.
//
// THIS FILE DECIDES WHAT CURRENT AND VOLTAGE GET WRITTEN TO A BATTERY CHARGER.
// The MC3000 does not range-check what it is sent — probed on hardware, it accepted
// a 1.0 V and a 2.0 V charge end-voltage on a NiMH without complaint — so these
// values are the only guard. Kept free of DOM and CSS imports so it can be unit
// tested; see test/defaults.test.ts, which pins every chemistry.
//
// Exercised on hardware: LiIon (21700, 18650) and NiMH (AA), firmware 1.25.
// NOT exercised: LiFe, LiIo4.35, NiCd, Eneloop, NiZn, RAM — those rows are
// chemistry-standard figures that no cell has yet been charged against here.

/** MC3000 field bounds: 0.05–3.0 A charge, 0.05–2.0 A discharge per slot.
 *  cutmin is our own input cap, not the device's — the charger accepts the full u16
 *  (probed: it took 65535 min without complaint), so this bound is the only guard. */
export const LIMIT = { chg: 3000, dis: 2000, cap: 60000, mv: 4500, endi: 1000, cutmin: 9999 };

// Safety cut-off time (minutes). The charger ends the program with a "timer cut" error
// (status 0x87) at this limit. It is TOTAL elapsed program time, NOT per-phase —
// confirmed on fw 1.25 at two values: a 180 min cut fired at 179 min, and a 990 min
// cut fired at 990 min (30 min into the discharge leg, after a full 16 h charge leg).
// A normal fast charge finishes well inside 180 min. A Break-in is an IEC 61951-2
// cycle — 0.1C ~16 h charge, discharge, ~16 h recharge — so it needs a timer covering
// the WHOLE ~34 h+ cycle, not just one leg. 2700 min (45 h) leaves margin; the exact
// full-cycle duration for this firmware is not yet measured (the 990 run only reached
// the discharge leg). The 45 °C temp cut remains the real safety backstop.
export const DEFAULT_CUT_MIN = 180, BREAKIN_CUT_MIN = 2700;
/** Cut time for a mode by its label — Break-in needs the long forming-charge window. */
export const cutMinFor = (modeLabel: string) =>
  modeLabel === "Break-in" ? BREAKIN_CUT_MIN : DEFAULT_CUT_MIN;

export const isLi = (type: string) => type.startsWith("Li");
export const endLabel = (type: string) =>
  isLi(type) ? "Target voltage (V)" : "Charge cut-off ceiling (V)";

// `targetMv` means two different things by chemistry, and getting that wrong ends a
// charge early. For Li*/NiZn/RAM it is a voltage the charger holds or charges up to.
// For NiMH/NiCd there is NO such target — they charge at constant current and
// terminate on −ΔV, dT/dt, cut temperature or the timer. The field is then a hard
// cut-off CEILING, and the industry figure is the published maximum charging voltage
// per cell, ~1.65 V for NiMH and NiCd (Energizer/Panasonic NiMH handbooks; IEC
// 61951-2 fast charge is 1C to −ΔV). A cell under a 0.5C charge sits at 1.45–1.55 V
// for most of the charge, so a 1500 ceiling terminates early — observed fw 1.25
// 2026-07-23, a NiMH stopped at 132 mAh, 9% of its rating.
export const DEFAULT_V: Record<string, { targetMv: number; cutMv: number }> = {
  LiIon: { targetMv: 4200, cutMv: 2750 }, "LiIo4.35": { targetMv: 4350, cutMv: 2750 },
  LiFe: { targetMv: 3600, cutMv: 2000 }, NiMH: { targetMv: 1650, cutMv: 900 },
  NiCd: { targetMv: 1650, cutMv: 900 }, Eneloop: { targetMv: 1650, cutMv: 900 },
  // RAM (rechargeable alkaline) is the one chemistry killed by depth of discharge
  // rather than by rate — cycle life collapses below ~1.0 V, so it gets a shallower
  // cut-off than the 0.9 V IEC endpoint used for NiMH/NiCd.
  NiZn: { targetMv: 1900, cutMv: 1200 }, RAM: { targetMv: 1650, cutMv: 1000 },
};

// Currents belong to the CELL, not the chemistry — a flat default is wrong by an
// order of magnitude across the range the MC3000 takes (10440 ~350 mAh to 21700
// ~5000 mAh). Derive a C-rate from the entered capacity: 0.5C charge is the standard
// fast-charge rate for both NiMH (IEC 61951-2 fast-charges up to 1C to −ΔV) and
// Li-ion, 0.5C discharge is a normal capacity-test rate, and 0.1C is the conventional
// CV-taper termination for Li.
export const C_CHARGE = 0.5, C_DISCHARGE = 0.5, C_TERMINATE = 0.1;
export const I_MIN = 50;
// With no capacity entered no rate can be derived. Fall back to currents that stay
// gentle even for the smallest cells the charger accepts, rather than to a number
// that is safe only for 18650s — the user can raise them after entering a capacity.
export const FALLBACK = { chg: 200, dis: 200, endi: 50 };

/** Charge/discharge current for a cell of `capMah` at C-rate `c`, in mA. */
export const rateMa = (capMah: number, c: number, fallback: number, max: number) =>
  // floor, not round, to the 50 mA input step — a default should err under the rate
  Math.min(max, Math.max(I_MIN, capMah > 0 ? Math.floor(capMah * c / 50) * 50 : fallback));

// Per-cell absolute safe voltage window by chemistry (volts). Sets the voltage
// chart's axis floor/ceiling so the charge curve is read against what's safe,
// not just against the data. Ni max is the published max charging voltage per cell
// (~1.65), not the ~1.5 V a cell sits at mid-charge — a healthy fast charge peaks
// near 1.55–1.6 V at −ΔV.
export const CHEM: Record<string, { min: number; max: number }> = {
  LiIon: { min: 2.5, max: 4.2 }, "LiIo4.35": { min: 2.5, max: 4.35 }, LiFe: { min: 2.0, max: 3.65 },
  NiMH: { min: 0.9, max: 1.65 }, NiCd: { min: 0.9, max: 1.65 }, Eneloop: { min: 0.9, max: 1.65 },
  NiZn: { min: 1.2, max: 1.9 }, RAM: { min: 0.9, max: 1.65 },
};

// --- estimated state of charge -------------------------------------------
// "% full" is NOT measured — the charger reports voltage, current, mAh-this-session
// and internal resistance, not absolute SoC. This is a VOLTAGE-based estimate, so
// treat it as approximate. Two honesty measures: (1) back the IR drop out of the
// terminal voltage using the device's own resistance reading, to approximate the
// cell's rested open-circuit voltage — terminal voltage reads high under charge and
// low under discharge, and that offset is I·R; (2) map OCV→SoC through a real
// per-cell curve for the Li chemistries, since their mid-range is flat and a linear
// voltage map would badly overstate the middle. Ni chemistries fall back to linear
// within the safe window (their OCV curve is flat and less standard — rougher).
import type { Live, SlotProgram } from "../../src/protocol/commands.ts";

// [volts-per-cell, SoC %] breakpoints, rested OCV. Li-ion from a standard discharge
// OCV table; the 4.35 variant shifts the top; LiFePO4 is deliberately flat.
const OCV_SOC: Record<string, [number, number][]> = {
  LiIon: [[3.0, 0], [3.3, 5], [3.45, 10], [3.55, 20], [3.65, 35], [3.75, 50], [3.85, 65], [3.95, 78], [4.05, 90], [4.15, 97], [4.2, 100]],
  "LiIo4.35": [[3.0, 0], [3.3, 4], [3.45, 8], [3.55, 17], [3.65, 30], [3.75, 43], [3.85, 57], [3.95, 70], [4.1, 85], [4.25, 96], [4.35, 100]],
  LiFe: [[2.5, 0], [3.0, 5], [3.2, 20], [3.28, 50], [3.32, 80], [3.4, 95], [3.6, 100]],
};

function interp(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]; const [x0, y0] = table[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return last[1];
}

/** Approximate state of charge (%), or null when no cell / unknown chemistry.
 *  Voltage/OCV-based, except in a Li CV phase where the terminal is pinned at the
 *  target and only the tapering current carries SoC — there we use the current. */
export function estimateSocPct(l: Live, prog?: SlotProgram | null): number | null {
  if (l.voltageMv <= 0) return null;                 // empty slot
  const chem = CHEM[l.batteryType];
  if (!chem) return null;
  // Li CV phase: charging, terminal at/above target. Voltage is clamped so it says
  // nothing; map the current taper from the charge setpoint (~80%) to the termination
  // current (100%). Without the program we can't detect CV and fall back to voltage.
  if (prog && l.batteryType.startsWith("Li") && l.statusRaw === 1
      && l.voltageMv >= prog.chargeEndMv - 30 && prog.chargeCurrentMa > prog.chargeEndCurrentMa) {
    const iTerm = Math.max(prog.chargeEndCurrentMa, 20);
    const frac = Math.max(0, Math.min(1, (prog.chargeCurrentMa - l.currentMa) / (prog.chargeCurrentMa - iTerm)));
    return Math.round(80 + 20 * frac);
  }
  let ocv = l.voltageMv / 1000;
  if (l.resistanceMOhm > 0) {                         // back out the I·R offset
    const drop = (l.currentMa / 1000) * (l.resistanceMOhm / 1000);
    if (l.statusRaw === 1) ocv -= drop;              // charging: terminal reads high
    else if (l.statusRaw === 2) ocv += drop;         // discharging: terminal reads low
  }
  const tab = OCV_SOC[l.batteryType];
  const soc = tab ? interp(tab, ocv) : (ocv - chem.min) / (chem.max - chem.min) * 100;
  return Math.max(0, Math.min(100, Math.round(soc)));
}
