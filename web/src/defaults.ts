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

/** MC3000 field bounds: 0.05–3.0 A charge, 0.05–2.0 A discharge per slot. */
export const LIMIT = { chg: 3000, dis: 2000, cap: 60000, mv: 4500, endi: 1000 };

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
