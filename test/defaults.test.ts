// These values are written to a battery charger that does NOT range-check them
// (probed on hardware: it accepted a 1.0 V and a 2.0 V charge end-voltage on a NiMH).
// Every bug found in real use during development was in this table or in the C-rate
// derivation, so both are pinned here rather than left to review.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  C_CHARGE, C_DISCHARGE, C_TERMINATE, CHEM, DEFAULT_V, FALLBACK, I_MIN, LIMIT, endLabel, isLi, rateMa,
} from "../web/src/defaults.ts";
import { BATTERY_TYPES } from "../src/protocol/commands.ts";

const chg = (cap: number) => rateMa(cap, C_CHARGE, FALLBACK.chg, LIMIT.chg);
const dis = (cap: number) => rateMa(cap, C_DISCHARGE, FALLBACK.dis, LIMIT.dis);
const end = (cap: number) => rateMa(cap, C_TERMINATE, FALLBACK.endi, LIMIT.endi);

test("every battery type the device reports has defaults and a chart window", () => {
  for (const t of BATTERY_TYPES) {
    assert.ok(DEFAULT_V[t], `no DEFAULT_V for ${t}`);
    assert.ok(CHEM[t], `no CHEM window for ${t}`);
  }
});

test("charge current never exceeds 1C, the NiMH fast-charge ceiling", () => {
  // The bug this pins: a flat 1000 mA default was 2.9C into a 10440.
  for (const cap of [350, 750, 800, 1450, 2000, 2500, 3000, 3500, 5000]) {
    const c = chg(cap) / cap;
    assert.ok(c <= 1.0, `${cap} mAh → ${chg(cap)} mA = ${c.toFixed(2)}C, above 1C`);
  }
});

test("derived currents are pinned across the cell range the MC3000 accepts", () => {
  // 10440 · AAA NiMH · 14500 · the AA under test · AA NiMH · 18650 · 21700
  assert.deepEqual([350, 750, 800, 1450, 2000, 3000, 5000].map(chg), [150, 350, 400, 700, 1000, 1500, 2500]);
  assert.deepEqual([350, 750, 800, 1450, 2000, 3000, 5000].map(end), [50, 50, 50, 100, 200, 300, 500]);
});

test("currents floor to the 50 mA step, so a default errs under the rate", () => {
  assert.equal(chg(350), 150);      // 175 → 150, not 200
  assert.equal(end(1450), 100);     // 145 → 100, not 150
});

test("currents stay inside the MC3000's per-slot bounds at both extremes", () => {
  assert.equal(chg(LIMIT.cap), LIMIT.chg);        // 60000 mAh clamps to 3.0 A
  assert.equal(dis(LIMIT.cap), LIMIT.dis);        // and 2.0 A on discharge
  assert.equal(chg(10), I_MIN);                   // tiny cell floors at 0.05 A
  assert.equal(end(10), I_MIN);
});

test("no capacity entered falls back to currents gentle for the smallest cell", () => {
  // 200 mA is 0.57C into a 350 mAh 10440 — high but survivable; the form says so.
  assert.equal(chg(0), FALLBACK.chg);
  assert.equal(end(0), FALLBACK.endi);
  assert.ok(FALLBACK.chg / 350 < 1.0, "fallback exceeds 1C on the smallest cell");
});

test("Li targets are the standard per-cell charge voltages", () => {
  assert.equal(DEFAULT_V.LiIon.targetMv, 4200);
  assert.equal(DEFAULT_V["LiIo4.35"].targetMv, 4350);
  assert.equal(DEFAULT_V.LiFe.targetMv, 3600);
});

test("Ni end-voltage is a cut-off ceiling above the −ΔV knee, not the mid-charge voltage", () => {
  // The bug this pins: 1500 mV terminated a NiMH at 132 mAh, 9% of its rating,
  // because a cell under a 0.5C charge sits at 1.45-1.55 V for most of the charge.
  for (const t of ["NiMH", "NiCd", "Eneloop"]) {
    assert.equal(DEFAULT_V[t].targetMv, 1650, `${t} ceiling must clear the knee`);
    assert.ok(DEFAULT_V[t].targetMv > 1550, `${t} ceiling is inside the normal charge range`);
  }
});

test("discharge cut-offs match each chemistry's endpoint", () => {
  assert.equal(DEFAULT_V.NiMH.cutMv, 900);        // IEC endpoint
  assert.equal(DEFAULT_V.LiIon.cutMv, 2750);
  assert.equal(DEFAULT_V.LiFe.cutMv, 2000);       // LiFePO4 datasheet minimum
  // RAM is limited by depth of discharge, not rate — shallower than the Ni endpoint.
  assert.ok(DEFAULT_V.RAM.cutMv > DEFAULT_V.NiMH.cutMv);
});

test("every default sits inside its own chart safety window", () => {
  for (const t of BATTERY_TYPES) {
    const d = DEFAULT_V[t], c = CHEM[t];
    assert.ok(d.targetMv / 1000 <= c.max, `${t} target ${d.targetMv} exceeds safe max ${c.max}V`);
    assert.ok(d.cutMv / 1000 >= c.min, `${t} cut ${d.cutMv} is below safe min ${c.min}V`);
    assert.ok(d.cutMv < d.targetMv, `${t} cut-off is not below its target`);
  }
});

test("the end-voltage field is labelled by what it does for that chemistry", () => {
  assert.ok(isLi("LiIon") && isLi("LiFe") && isLi("LiIo4.35"));
  assert.ok(!isLi("NiMH") && !isLi("NiZn") && !isLi("RAM"));
  assert.match(endLabel("LiIon"), /Target/);
  assert.match(endLabel("NiMH"), /ceiling/);
});
