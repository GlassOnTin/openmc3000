import "./style.css";
import {
  BATTERY_TYPES, buildSetProgram, isSetProgramAck, parseLive, parseSlotProgram, parseSystem,
  readLive, readSlotProgram, readSystem, start, stop,
  type Live, type ProgramEdits, type SlotProgram, type System,
} from "../../src/protocol/commands.ts";
import { checkReply } from "../../src/protocol/frame.ts";
import { request, type Transport } from "../../src/transport/transport.ts";
import { WebHidTransport } from "../../src/transport/webhid.ts";
import {
  CHEM, C_CHARGE, C_DISCHARGE, C_TERMINATE, DEFAULT_V, FALLBACK, LIMIT, endLabel, rateMa,
} from "./defaults.ts";

const app = document.getElementById("app")!;
let transport: Transport | null = null;
let timer: number | undefined;

const h = (html: string) => { app.innerHTML = html; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Serialize ALL device I/O: overlapping transactions (the poll interval vs a
// start/stop click) interleave drain/send/receive and cause mismatched replies.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function live(slot: number): Promise<Live> {
  const reply = await request(transport!, readLive(slot));
  if (!checkReply(reply)) throw new Error(`bad checksum on slot ${slot + 1}`);
  return parseLive(reply);
}

async function liveRetry(slot: number): Promise<Live> {
  try { return await withLock(() => live(slot)); }
  catch { await sleep(60); return withLock(() => live(slot)); }   // one retry
}

function slotRow(l: Live): string {
  const present = l.voltageMv > 0 || l.statusRaw !== 0;
  const running = l.statusRaw === 1 || l.statusRaw === 2;   // charge / discharge
  // power (bytes 22-23) is only meaningful while running; stale in standby.
  const power = running ? `${(l.powerMw / 1000).toFixed(2)} W` : "—";
  const cells = present
    ? `<td>${l.batteryType}</td><td>${l.status}</td>
       <td>${(l.voltageMv / 1000).toFixed(3)} V</td>
       <td>${l.currentMa} mA</td><td>${l.capacityMah} mAh</td>
       <td>${power}</td>`
    : `<td colspan="6" class="empty">— empty —</td>`;
  const temp = `<td>${(l.temperatureRaw / 10).toFixed(1)} °C</td>`;   // slot sensor, present or not
  const charging = l.statusRaw === 1;
  // editing writes a slot's program; block it while that slot is actively running.
  const edit = `<td><button class="edit" data-slot="${l.slot}" ${running ? "disabled" : ""}>edit</button></td>`;
  return `<tr class="${charging ? "charging" : ""}"><th>Slot ${l.slot + 1}</th>${cells}${temp}${edit}</tr>`;
}

function setStatus(msg: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

// --- live charts ----------------------------------------------------------
// 4 per-slot small multiples, all showing ONE measure at a time (single axis
// each — never a dual voltage/current axis). Selector switches all four.
type Sample = { v: number; i: number; cap: number; t: number; ts: number };  // t = temp raw, ts = epoch ms
type Measure = "v" | "i" | "cap" | "t";
const MEASURES: Record<Measure, { label: string; unit: string; pick: (s: Sample) => number; fmt: (n: number) => string; zeroBased: boolean }> = {
  v:   { label: "Voltage", unit: "V",   pick: (s) => s.v / 1000, fmt: (n) => n.toFixed(2), zeroBased: false },
  i:   { label: "Current", unit: "mA",  pick: (s) => s.i,        fmt: (n) => n.toFixed(0), zeroBased: true },
  cap: { label: "Capacity", unit: "mAh", pick: (s) => s.cap,     fmt: (n) => n.toFixed(0), zeroBased: true },
  t:   { label: "Temperature", unit: "°C", pick: (s) => s.t / 10, fmt: (n) => n.toFixed(1), zeroBased: false },
};
const HISTORY_MAX = 600;                       // ~10 min at 1 Hz
const history: Sample[][] = [[], [], [], []];
const programs: (SlotProgram | null)[] = [null, null, null, null];
const latest: (Live | null)[] = [null, null, null, null];
let measure: Measure = "v";

const W = 320, H = 140, padL = 44, padR = 12, padT = 10, padB = 26;
// Charges run for hours, so carry into hours rather than reporting "123:47". Two
// units is enough — seconds on a two-hour estimate are noise.
const fmtDur = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
};

function chartSvg(slot: number, samples: Sample[], prog: SlotProgram | null): string {
  const m = MEASURES[measure];
  if (samples.length < 2) {
    return `<figure class="chart"><figcaption>Slot ${slot + 1}</figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slot ${slot + 1}: waiting for data">
      <text x="${W / 2}" y="${H / 2}" class="c-empty" text-anchor="middle">collecting…</text></svg></figure>`;
  }
  const vals = samples.map(m.pick);

  // Voltage: axis and safety bands come from the slot's targets + chemistry, not the data.
  const chem = prog ? CHEM[prog.batteryType] : undefined;
  let lo: number, hi: number;
  if (measure === "v" && prog && chem) {
    const target = prog.chargeEndMv / 1000;
    lo = chem.min;
    hi = Math.max(target * 1.03, ...vals, lo + 0.1);   // headroom above target, never clip data
  } else {
    lo = m.zeroBased ? 0 : Math.min(...vals);
    hi = Math.max(...vals, m.zeroBased ? 1 : lo);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    if (!m.zeroBased) lo -= pad;
    hi += pad;
  }

  // x maps by actual time so gaps (skipped/errored polls) don't distort the curve.
  const t0 = samples[0].ts, span = Math.max(1, samples[samples.length - 1].ts - t0);
  const x = (i: number) => padL + ((samples[i].ts - t0) / span) * (W - padL - padR);
  const y = (val: number) => padT + (1 - (val - lo) / (hi - lo)) * (H - padT - padB);
  const plotW = W - padL - padR;
  const band = (vTop: number, vBot: number, cls: string) => {
    const yTop = Math.max(padT, y(vTop)), yBot = Math.min(H - padB, y(vBot));
    return yBot > yTop ? `<rect class="${cls}" x="${padL}" y="${yTop.toFixed(1)}" width="${plotW}" height="${(yBot - yTop).toFixed(1)}"/>` : "";
  };
  const refLine = (v: number, label: string) => {
    if (v < lo || v > hi) return "";
    const yy = y(v);
    return `<line class="c-ref" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"/>
            <text class="c-reflbl" x="${W - padR - 1}" y="${(yy - 2).toFixed(1)}" text-anchor="end">${label}</text>`;
  };

  let bands = "", refs = "";
  if (measure === "v" && prog && chem) {
    const target = prog.chargeEndMv / 1000, cutoff = prog.dischargeCutMv / 1000;
    bands = band(hi, target, "c-band-over") + band(target, cutoff, "c-band-safe") + band(cutoff, lo, "c-band-under");
    refs = refLine(target, `${target.toFixed(2)}V target`) + refLine(cutoff, `${cutoff.toFixed(2)}V cut`);
  } else if (measure === "i" && prog && prog.chargeCurrentMa > 0) {
    refs = refLine(prog.chargeCurrentMa, `${prog.chargeCurrentMa} mA set`);
  }

  const pts = vals.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" ");
  const latest = m.fmt(vals[vals.length - 1]);
  return `<figure class="chart">
    <figcaption>Slot ${slot + 1} <span class="c-latest">${latest} ${m.unit}</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Slot ${slot + 1} ${m.label} over time, latest ${latest} ${m.unit}">
      ${bands}
      <line class="c-axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"/>
      <line class="c-axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"/>
      <text class="c-tick" x="${padL - 4}" y="${padT + 4}" text-anchor="end">${m.fmt(hi)}</text>
      <text class="c-tick" x="${padL - 4}" y="${H - padB}" text-anchor="end">${m.fmt(lo)}</text>
      <text class="c-tick" x="${padL}" y="${H - 6}" text-anchor="start">-${fmtDur(span / 1000)}</text>
      <text class="c-tick" x="${W - padR}" y="${H - 6}" text-anchor="end">now</text>
      ${refs}
      <polyline class="c-line" points="${pts}"/>
    </svg></figure>`;
}

function renderCharts() {
  const el = document.getElementById("charts");
  if (!el) return;
  // Only chart slots that have data — empty slots never accumulate samples, so
  // don't reserve dead "collecting…" tiles for them.
  const active = history.map((s, slot) => [slot, s] as const).filter(([, s]) => s.length > 0);
  el.innerHTML = active.length
    ? active.map(([slot, s]) => chartSvg(slot, s, programs[slot])).join("")
    : `<p class="dev">Charts appear once a slot has a cell and live readings.</p>`;
}

// --- charge/discharge modelling -------------------------------------------
const isNi = (type: string) => ["NiMH", "NiCd", "Eneloop"].includes(type);

/** Human-readable state of the cell, covering charge sub-phases and discharge. */
function phaseWord(l: Live, prog: SlotProgram | null): string {
  const s = l.statusRaw;
  if (s >= 0x80) return `Error 0x${s.toString(16)}`;
  if (s === 0) return "Idle";
  if (s === 3) return "Resting";
  if (s === 4) return "Done";
  if (s === 2) return prog && l.voltageMv <= prog.dischargeCutMv + 50 ? "Discharging · near cut-off" : "Discharging";
  if (s === 1) {
    if (!prog) return "Charging";
    if (isNi(l.batteryType)) return "Charging (CC, −ΔV term)";
    const termI = Math.max(prog.chargeEndCurrentMa, 20);
    if (l.voltageMv >= prog.chargeEndMv - 20)
      return l.currentMa <= termI * 1.5 ? "Absorption · topping off" : "Absorption (CV)";
    return "Bulk (CC)";
  }
  return "—";
}

/** Rough time-remaining estimate. CV: extrapolate exponential current decay to the
 *  termination current. Discharge: linear voltage slope to the cut-off. Marked "~". */
// The charger periodically drops the current to ~40% for ~2 s (measured: every ~21 s
// on a NiMH at 1 A) to sample a less-loaded terminal voltage. That's ~10% of samples,
// so endpoint slopes and the instantaneous current are unusable here — take medians.
const median = (xs: number[]) => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1]; };

function estimateEta(hist: Sample[], l: Live, prog: SlotProgram | null): string | null {
  if (!prog || hist.length < 8) return null;
  const win = hist.slice(-25);                       // ≥ one dip period at 1 Hz
  const dt = (win[win.length - 1].ts - win[0].ts) / 1000;
  if (dt <= 0) return null;
  const half = win.length >> 1;
  const medOf = (from: number, to: number, f: (s: Sample) => number) => median(win.slice(from, to).map(f));
  const iNow = median(win.map((s) => s.i));
  // Only the Li chemistries hold a CV phase; NiMH/NiCd/NiZn/RAM charge at constant
  // current until −ΔV or a timer, and their end-voltage field is not a CV setpoint.
  const cv = l.batteryType.startsWith("Li") && l.voltageMv >= prog.chargeEndMv - 20;
  if (l.statusRaw === 1 && cv) {                     // CV: extrapolate current decay
    const termI = Math.max(prog.chargeEndCurrentMa, 20);
    const i0 = medOf(0, half, (s) => s.i), i1 = medOf(half, win.length, (s) => s.i);
    if (i1 < i0 && i1 > 0 && iNow > termI) {
      const tau = -(dt / 2) / Math.log(i1 / i0);     // halves are ~dt/2 apart
      const secs = tau * Math.log(iNow / termI);
      if (secs > 0 && secs < 86400) return `~${fmtDur(secs)} to termination`;
    }
  } else if (l.statusRaw === 1 && prog.capacityMah > 0 && iNow > 0) {   // CC: coulomb count
    const secs = (prog.capacityMah - l.capacityMah) / iNow * 3600;
    if (secs > 0 && secs < 86400) return `~${fmtDur(secs)} to rated capacity`;
  } else if (l.statusRaw === 2) {                    // discharge: voltage slope to cut-off
    const v0 = medOf(0, half, (s) => s.v), v1 = medOf(half, win.length, (s) => s.v);
    if (v1 < v0) {
      const secs = (prog.dischargeCutMv - l.voltageMv) / ((v1 - v0) / (dt / 2));
      if (secs > 0 && secs < 86400) return `~${fmtDur(secs)} to cut-off`;
    }
  }
  return null;
}

// Only DERIVED / session metrics — the live V/I/cap/power/temp snapshot lives in the
// table above, so we deliberately don't repeat it here.
function analyze(hist: Sample[], l: Live, prog: SlotProgram | null): { k: string; v: string }[] {
  const rows: { k: string; v: string }[] = [];
  const running = l.statusRaw === 1 || l.statusRaw === 2;
  const nominal = prog?.capacityMah ?? 0;
  if (hist.length >= 2) rows.push({ k: "Elapsed", v: fmtDur((hist[hist.length - 1].ts - hist[0].ts) / 1000) });
  if (nominal > 0) rows.push({ k: l.statusRaw === 2 ? "Removed vs rated" : "Charged vs rated", v: `${(l.capacityMah / nominal * 100).toFixed(0)}% of ${nominal} mAh` });
  rows.push({ k: "Energy", v: `${(l.energyMwh / 1000).toFixed(2)} Wh` });
  if (l.resistanceMOhm > 0) rows.push({ k: "Internal resistance", v: `${l.resistanceMOhm} mΩ` });
  if (nominal > 0 && running) rows.push({ k: "C-rate", v: `${(l.currentMa / nominal).toFixed(2)}C` });
  if (hist.length >= 2) {
    const dT = (l.temperatureRaw - hist[0].t) / 10;
    if (Math.abs(dT) >= 0.1) rows.push({ k: "Temp rise", v: `${dT >= 0 ? "+" : ""}${dT.toFixed(1)} °C` });
    const avgI = Math.round(hist.reduce((a, s) => a + s.i, 0) / hist.length);
    rows.push({ k: "Avg / peak current", v: `${avgI} / ${Math.max(...hist.map((s) => s.i))} mA` });
    rows.push({ k: "Peak voltage", v: `${(Math.max(...hist.map((s) => s.v)) / 1000).toFixed(3)} V` });
  }
  const eta = estimateEta(hist, l, prog);
  if (eta) rows.push({ k: "Est. remaining", v: eta });
  return rows;
}

function renderAnalysis() {
  const el = document.getElementById("analysis");
  if (!el) return;
  const cards = [0, 1, 2, 3].filter((s) => latest[s] && history[s].length > 0).map((s) => {
    const l = latest[s]!;
    const rows = analyze(history[s], l, programs[s]);
    return `<div class="acard">
      <div class="ahead">Slot ${s + 1} <span class="phase">${phaseWord(l, programs[s])}</span></div>
      <dl>${rows.map((r) => `<dt>${r.k}</dt><dd>${r.v}</dd>`).join("")}</dl>
    </div>`;
  });
  el.innerHTML = cards.length
    ? cards.join("") + `<p class="dev anote">Energy &amp; internal resistance are device-measured; capacity %, C-rate, ΔT and time-remaining are computed. Internal resistance is the main health indicator — lower is better, judged against the cell's rating.</p>`
    : "";
}

async function loadPrograms() {
  for (let s = 0; s < 4; s++) {
    try {
      const r = await withLock(() => request(transport!, readSlotProgram(s)));
      if (checkReply(r)) programs[s] = parseSlotProgram(r);
    } catch { /* leave null — chart falls back to data-autoscale */ }
  }
}

// --- session recording + CSV export ---------------------------------------
type RecRow = { t: number; lives: (Live | null)[] };
const REC_MAX = 86400;                 // ~24 h at 1 Hz — safety cap
let recRows: RecRow[] = [];
let recStart = 0;
let recording = false;

function toggleRecord() {
  if (recording) recording = false;
  else { recording = true; recRows = []; recStart = Date.now(); }
  updateRecUi();
}

function updateRecUi() {
  const btn = document.getElementById("rec-toggle") as HTMLButtonElement | null;
  const dl = document.getElementById("rec-dl") as HTMLButtonElement | null;
  const st = document.getElementById("rec-status");
  if (!btn || !dl || !st) return;
  btn.textContent = recording ? "■ Stop recording" : "● Record";
  btn.classList.toggle("rec-on", recording);
  dl.disabled = recRows.length === 0;
  st.textContent = recRows.length
    ? `${recRows.length} sample${recRows.length === 1 ? "" : "s"}${recording ? " — recording…" : " recorded"}`
    : "";
}

function buildCsv(): string {
  const cols = ["time_iso", "elapsed_s"];
  for (let s = 1; s <= 4; s++) cols.push(`s${s}_status`, `s${s}_V`, `s${s}_mA`, `s${s}_mAh`, `s${s}_degC`);
  const lines = [cols.join(",")];
  for (const r of recRows) {
    const cells = [new Date(r.t).toISOString(), ((r.t - recStart) / 1000).toFixed(1)];
    for (const l of r.lives) {
      if (l) cells.push(l.status, (l.voltageMv / 1000).toFixed(3), String(l.currentMa), String(l.capacityMah), (l.temperatureRaw / 10).toFixed(1));
      else cells.push("", "", "", "", "");
    }
    lines.push(cells.join(","));
  }
  return lines.join("\n");
}

function downloadCsv() {
  if (!recRows.length) return;
  const blob = new Blob([buildCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mc3000-${new Date(recStart).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

let polling = false;   // guard against overlapping refreshes stacking up
async function refresh() {
  if (polling || !transport) return;
  polling = true;
  try {
    const rows = [];
    const lives: (Live | null)[] = [null, null, null, null];
    let errs = 0;
    for (let s = 0; s < 4; s++) {
      try {
        const l = await liveRetry(s);
        lives[s] = l;
        latest[s] = l;
        rows.push(slotRow(l));
        const present = l.voltageMv > 0 || l.statusRaw !== 0;
        if (present) {
          const buf = history[s];
          buf.push({ v: l.voltageMv, i: l.currentMa, cap: l.capacityMah, t: l.temperatureRaw, ts: Date.now() });
          if (buf.length > HISTORY_MAX) buf.shift();
        }
      } catch {
        errs++;
        rows.push(`<tr><th>Slot ${s + 1}</th><td colspan="7" class="empty">read error, retrying…</td><td></td></tr>`);
      }
    }
    const el = document.getElementById("slots");
    if (el) el.innerHTML = rows.join("");
    renderAnalysis();
    renderCharts();
    if (recording && recRows.length < REC_MAX) { recRows.push({ t: Date.now(), lives }); updateRecUi(); }
    // A transient read error is NOT a disconnect — keep polling. Real removal
    // arrives via the WebHID 'disconnect' event (see connect()).
    setStatus(errs ? `${errs}/4 slots failed this poll — retrying` : "");
  } finally {
    polling = false;
  }
}

function startPolling() {
  stopPolling();
  timer = window.setInterval(refresh, 1000);
  refresh();
}
function stopPolling() { if (timer) { clearInterval(timer); timer = undefined; } }

async function onStart() {
  setStatus("starting…");
  // ponytail: the charger ignores START if a slot is latched — reproducibly seen
  // right after a program save (observed fw 1.25, NiMH slot 1); a STOP first clears
  // it. Skipped when something is already running so a charge in progress, and its
  // capacity counters, are never interrupted.
  if (!latest.some((l) => l && (l.statusRaw === 1 || l.statusRaw === 2))) {
    await withLock(() => transport!.send(stop()));
    await sleep(250);
  }
  await withLock(() => transport!.send(start()));   // no reply; charger acts silently
  await sleep(1500);                                // soft-start ramps over ~7 s
  setStatus("");
}
async function onStop() {
  setStatus("stopping…");
  await withLock(() => transport!.send(stop()));
  await sleep(400);
  setStatus("");
}

// --- slot program editing -------------------------------------------------
// All fields below are verified to round-trip on fw 1.25 (buildSetProgram offsets
// tested on hardware). Fields not exposed here (cycle count/mode, −ΔV peak sense,
// trickle, cut temp/time, resting times) are preserved verbatim by the repack.
// Operation-mode labels are chemistry-dependent, so they track the selected type.
const MODES_LI = ["Charge", "Refresh", "Storage", "Discharge", "Cycle"];
const MODES_NI = ["Charge", "Refresh", "Break-in", "Discharge", "Cycle"];
const MODES_ZN = ["Charge", "Refresh", "Discharge", "Cycle"];
const modeSetFor = (type: string) =>
  ["NiMH", "NiCd", "Eneloop"].includes(type) ? MODES_NI
    : ["NiZn", "RAM"].includes(type) ? MODES_ZN : MODES_LI;

function modeOptions(type: string, selected: number): string {
  return modeSetFor(type).map((m, i) => `<option value="${i}" ${i === selected ? "selected" : ""}>${m}</option>`).join("");
}

function closeEditor() {
  const el = document.getElementById("editor");
  if (el) el.innerHTML = "";
  startPolling();
}

async function openEditor(slot: number) {
  stopPolling();
  setStatus(`reading slot ${slot + 1} program…`);
  let p;
  try {
    const reply = await withLock(() => request(transport!, readSlotProgram(slot)));
    if (!checkReply(reply)) throw new Error("bad program checksum");
    p = parseSlotProgram(reply);
  } catch (e) {
    setStatus(`could not read slot ${slot + 1}: ${(e as Error).message}`);
    startPolling();
    return;
  }
  setStatus("");
  const typeOpts = BATTERY_TYPES.map((b) => `<option value="${b}" ${b === p.batteryType ? "selected" : ""}>${b}</option>`).join("");
  const num = (id: string, label: string, val: number | string, max: number, step: number) =>
    `<label>${label}<input id="${id}" type="number" min="0" max="${max}" step="${step}" value="${val}"></label>`;
  document.getElementById("editor")!.innerHTML = `
    <div class="editor">
      <h2>Slot ${slot + 1} — edit program</h2>
      <div class="grid">
        <label>Battery type<select id="ed-type">${typeOpts}</select></label>
        <label>Mode<select id="ed-mode">${modeOptions(p.batteryType, p.mode)}</select></label>
        ${num("ed-cap", "Capacity (mAh)", p.capacityMah, LIMIT.cap, 100)}
        ${num("ed-chg", "Charge current (mA)", p.chargeCurrentMa, LIMIT.chg, 50)}
        ${num("ed-dis", "Discharge current (mA)", p.dischargeCurrentMa, LIMIT.dis, 50)}
        ${num("ed-end", endLabel(p.batteryType), (p.chargeEndMv / 1000).toFixed(2), LIMIT.mv / 1000, 0.05)}
        ${num("ed-cut", "Cut-off voltage (V)", (p.dischargeCutMv / 1000).toFixed(2), LIMIT.mv / 1000, 0.05)}
        ${num("ed-endi", "Termination current (mA)", p.chargeEndCurrentMa, LIMIT.endi, 10)}
      </div>
      <div class="controls">
        <button id="ed-save">Save to slot ${slot + 1}</button>
        <button id="ed-reset">Reset to defaults</button>
        <button id="ed-cancel">Cancel</button>
      </div>
      <p id="ed-msg" class="status"></p>
      <p class="note">Reset fills chemistry-standard defaults into the form (review, then Save), keeping
        the capacity and deriving the currents from it at 0.5C. The saved result is read back and shown.
        The charger does <em>not</em> range-check these against the chemistry — it accepted 1.0 V and
        2.0 V end-voltages on a NiMH when probed — so the values here are the only guard.</p>
    </div>`;
  const typeSel = document.getElementById("ed-type") as HTMLSelectElement;
  const modeSel = document.getElementById("ed-mode") as HTMLSelectElement;
  const setInput = (id: string, v: string | number) => { (document.getElementById(id) as HTMLInputElement).value = String(v); };
  typeSel.addEventListener("change", () => {
    modeSel.innerHTML = modeOptions(typeSel.value, Number(modeSel.value));
    // the end-voltage field is a CV target on Li but a cut-off ceiling on the rest
    document.getElementById("ed-end")!.parentElement!.firstChild!.nodeValue = endLabel(typeSel.value);
  });
  document.getElementById("ed-reset")!.addEventListener("click", () => {
    const d = DEFAULT_V[typeSel.value] ?? DEFAULT_V.LiIon;
    // Keep the capacity — it identifies the cell, so it is the one field a reset must
    // not throw away, and every current below is derived from it.
    const cap = Number((document.getElementById("ed-cap") as HTMLInputElement).value) || 0;
    modeSel.value = "0";                               // Charge
    setInput("ed-chg", rateMa(cap, C_CHARGE, FALLBACK.chg, LIMIT.chg));
    setInput("ed-dis", rateMa(cap, C_DISCHARGE, FALLBACK.dis, LIMIT.dis));
    setInput("ed-end", (d.targetMv / 1000).toFixed(2));
    setInput("ed-cut", (d.cutMv / 1000).toFixed(2));
    setInput("ed-endi", rateMa(cap, C_TERMINATE, FALLBACK.endi, LIMIT.endi));
    (document.getElementById("ed-msg")!).textContent = cap > 0
      ? `defaults for ${typeSel.value} at ${cap} mAh (${C_CHARGE}C charge) — review and Save`
      : `defaults for ${typeSel.value} — no capacity set, so currents are minimums; enter the cell's mAh and reset again for 0.5C`;
  });
  document.getElementById("ed-cancel")!.addEventListener("click", closeEditor);
  document.getElementById("ed-save")!.addEventListener("click", () => saveEditor(slot, p.raw));
}

async function saveEditor(slot: number, raw: Uint8Array) {
  const msg = (m: string) => { const e = document.getElementById("ed-msg"); if (e) e.textContent = m; };
  const val = (id: string) => Number((document.getElementById(id) as HTMLInputElement).value);
  const edits: ProgramEdits = {
    batteryType: BATTERY_TYPES.indexOf((document.getElementById("ed-type") as HTMLSelectElement).value as typeof BATTERY_TYPES[number]),
    operationMode: val("ed-mode"),
    capacityMah: val("ed-cap"),
    chargeCurrentMa: val("ed-chg"),
    dischargeCurrentMa: val("ed-dis"),
    chargeEndMv: Math.round(val("ed-end") * 1000),
    dischargeCutMv: Math.round(val("ed-cut") * 1000),
    chargeEndCurrentMa: val("ed-endi"),
  };
  const checks: [number, number][] = [
    [edits.chargeCurrentMa!, LIMIT.chg], [edits.dischargeCurrentMa!, LIMIT.dis],
    [edits.capacityMah!, LIMIT.cap], [edits.chargeEndMv!, LIMIT.mv],
    [edits.dischargeCutMv!, LIMIT.mv], [edits.chargeEndCurrentMa!, LIMIT.endi],
  ];
  if (checks.some(([v, max]) => !Number.isFinite(v) || v < 0 || v > max)) {
    msg("a value is out of range — check the limits and try again");
    return;
  }
  msg("writing…");
  try {
    const ack = await withLock(() => request(transport!, buildSetProgram(raw, slot, edits)));
    if (!isSetProgramAck(ack)) throw new Error(`charger rejected the write (0x${ack[0].toString(16)})`);
    const back = parseSlotProgram(await withLock(() => request(transport!, readSlotProgram(slot))));
    programs[slot] = back;                 // keep chart targets in sync with the edit
    // The charger may clamp to chemistry limits — report what it actually stored.
    const clamped = back.chargeEndMv !== edits.chargeEndMv || back.dischargeCutMv !== edits.dischargeCutMv
      || back.chargeCurrentMa !== edits.chargeCurrentMa;
    // Confirm in the editor (the 1 Hz poll would instantly clobber a setStatus), then close.
    msg(`saved ✓${clamped ? " — charger adjusted to chemistry limits" : ""}: ${back.batteryType} · `
      + `${modeSetFor(back.batteryType)[back.mode] ?? back.mode} · ${back.chargeCurrentMa} mA → ${(back.chargeEndMv / 1000).toFixed(2)} V`);
    setTimeout(closeEditor, 1600);
  } catch (e) {
    msg((e as Error).message);
  }
}

async function connect() {
  const t = await WebHidTransport.request();
  if (!t) return;                       // user dismissed the chooser
  transport = t;
  t.onDisconnect(() => {                 // authoritative: device physically gone
    stopPolling();
    transport = null;
    renderDisconnected("charger disconnected — unplugged or powered off");
  });
  const sys = parseSystem(await withLock(() => request(t, readSystem())));
  renderConnected(t.productName, sys);
  await loadPrograms();                  // targets/chemistry for the voltage chart bands
  startPolling();
}

function renderConnected(name: string, sys: System) {
  const settings = `beep ${sys.beepOn ? "on" : "off"} · ${sys.tempUnit === "F" ? "°F" : "°C"}`
    + (sys.hiddenChem.length ? ` · hidden: ${sys.hiddenChem.join(", ")}` : "");
  h(`
    <h1>openMC3000</h1>
    <p class="dev">${name} · serial ${sys.serial} · firmware ${sys.firmware} · hardware ${sys.hardware}</p>
    <p class="dev">Device settings (read-only, change on the charger): ${settings}</p>
    <div class="controls">
      <button id="start">▶ Start (all)</button>
      <button id="stop">■ Stop (all)</button>
    </div>
    <table>
      <thead><tr><th>Slot</th><th>Type</th><th>Status</th><th>Voltage</th><th>Current</th><th>Capacity</th><th>Power</th><th>Temp</th><th></th></tr></thead>
      <tbody id="slots"></tbody>
    </table>
    <p id="status" class="status"></p>
    <div id="editor"></div>
    <div id="analysis" class="analysis"></div>
    <div class="chart-head">
      <label>Chart:
        <select id="measure">
          <option value="v">Voltage (V)</option>
          <option value="i">Current (mA)</option>
          <option value="cap">Capacity (mAh)</option>
          <option value="t">Temperature (°C)</option>
        </select>
      </label>
      <span class="rec">
        <button id="rec-toggle">● Record</button>
        <button id="rec-dl" disabled>⭳ Download CSV</button>
        <span id="rec-status" class="dev"></span>
      </span>
    </div>
    <div id="charts" class="charts"></div>
    <p class="note">Start/Stop are global — the MC3000 has no per-slot start over USB/BLE.
       Editing writes charge/discharge current only; other program fields are preserved.</p>
  `);
  document.getElementById("start")!.addEventListener("click", onStart);
  document.getElementById("stop")!.addEventListener("click", onStop);
  const sel = document.getElementById("measure") as HTMLSelectElement;
  sel.value = measure;
  sel.addEventListener("change", () => { measure = sel.value as Measure; renderCharts(); });
  document.getElementById("rec-toggle")!.addEventListener("click", toggleRecord);
  document.getElementById("rec-dl")!.addEventListener("click", downloadCsv);
  updateRecUi();   // reflect any in-progress recording after a re-render
  // delegated: slot rows (hence edit buttons) are regenerated every poll
  document.getElementById("slots")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".edit") as HTMLButtonElement | null;
    if (btn && !btn.disabled) openEditor(Number(btn.dataset.slot));
  });
}

function renderDisconnected(msg = "") {
  h(`
    <h1>openMC3000</h1>
    <p>Control a SkyRC MC3000 from the browser over WebHID.</p>
    <p class="note">This starts real charges and writes charge parameters to the device. The
      charger does <em>not</em> range-check what it is sent, so the values you save are the only
      guard — review them, and know your cell.</p>
    <button id="connect">Connect charger</button>
    ${msg ? `<p class="err">${msg}</p>` : ""}
    ${"hid" in navigator ? "" : `<p class="err">This browser has no WebHID. Use desktop Chrome or Edge.</p>`}
  `);
  document.getElementById("connect")!.addEventListener("click", connect);
}

renderDisconnected();
