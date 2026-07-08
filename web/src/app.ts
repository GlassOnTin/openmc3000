import "./style.css";
import {
  buildSetProgram, isSetProgramAck, parseLive, parseSlotProgram, parseSystem,
  readLive, readSlotProgram, readSystem, start, stop, type Live, type SlotProgram,
} from "../../src/protocol/commands.ts";
import { checkReply } from "../../src/protocol/frame.ts";
import { request, type Transport } from "../../src/transport/transport.ts";
import { WebHidTransport } from "../../src/transport/webhid.ts";

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
  const charging = l.statusRaw === 1;
  // editing writes a slot's program; block it while that slot is actively running.
  const edit = `<td><button class="edit" data-slot="${l.slot}" ${running ? "disabled" : ""}>edit</button></td>`;
  return `<tr class="${charging ? "charging" : ""}"><th>Slot ${l.slot + 1}</th>${cells}${edit}</tr>`;
}

function setStatus(msg: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

// --- live charts ----------------------------------------------------------
// 4 per-slot small multiples, all showing ONE measure at a time (single axis
// each — never a dual voltage/current axis). Selector switches all four.
type Sample = { v: number; i: number; cap: number };
type Measure = "v" | "i" | "cap";
const MEASURES: Record<Measure, { label: string; unit: string; pick: (s: Sample) => number; fmt: (n: number) => string; zeroBased: boolean }> = {
  v:   { label: "Voltage", unit: "V",   pick: (s) => s.v / 1000, fmt: (n) => n.toFixed(2), zeroBased: false },
  i:   { label: "Current", unit: "mA",  pick: (s) => s.i,        fmt: (n) => n.toFixed(0), zeroBased: true },
  cap: { label: "Capacity", unit: "mAh", pick: (s) => s.cap,     fmt: (n) => n.toFixed(0), zeroBased: true },
};
const HISTORY_MAX = 600;                       // ~10 min at 1 Hz
const history: Sample[][] = [[], [], [], []];
const programs: (SlotProgram | null)[] = [null, null, null, null];
let measure: Measure = "v";

// Per-cell absolute safe voltage window by chemistry (volts). Sets the voltage
// chart's axis floor/ceiling so the charge curve is read against what's safe,
// not just against the data. Approximate, chemistry-standard values.
const CHEM: Record<string, { min: number; max: number }> = {
  LiIon: { min: 2.5, max: 4.2 }, "LiIo4.35": { min: 2.5, max: 4.35 }, LiFe: { min: 2.0, max: 3.65 },
  NiMH: { min: 0.9, max: 1.5 }, NiCd: { min: 0.9, max: 1.5 }, Eneloop: { min: 0.9, max: 1.5 },
  NiZn: { min: 1.2, max: 1.9 }, RAM: { min: 0.9, max: 1.65 },
};

const W = 300, H = 120, padL = 42, padR = 10, padT = 10, padB = 18;

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

  const x = (i: number) => padL + (i / (samples.length - 1)) * (W - padL - padR);
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
      ${refs}
      <polyline class="c-line" points="${pts}"/>
    </svg></figure>`;
}

function renderCharts() {
  const el = document.getElementById("charts");
  if (!el) return;
  el.innerHTML = history.map((s, slot) => chartSvg(slot, s, programs[slot])).join("");
}

async function loadPrograms() {
  for (let s = 0; s < 4; s++) {
    try {
      const r = await withLock(() => request(transport!, readSlotProgram(s)));
      if (checkReply(r)) programs[s] = parseSlotProgram(r);
    } catch { /* leave null — chart falls back to data-autoscale */ }
  }
}

let polling = false;   // guard against overlapping refreshes stacking up
async function refresh() {
  if (polling || !transport) return;
  polling = true;
  try {
    const rows = [];
    let errs = 0;
    for (let s = 0; s < 4; s++) {
      try {
        const l = await liveRetry(s);
        rows.push(slotRow(l));
        const present = l.voltageMv > 0 || l.statusRaw !== 0;
        if (present) {
          const buf = history[s];
          buf.push({ v: l.voltageMv, i: l.currentMa, cap: l.capacityMah });
          if (buf.length > HISTORY_MAX) buf.shift();
        }
      } catch {
        errs++;
        rows.push(`<tr><th>Slot ${s + 1}</th><td colspan="6" class="empty">read error, retrying…</td><td></td></tr>`);
      }
    }
    const el = document.getElementById("slots");
    if (el) el.innerHTML = rows.join("");
    renderCharts();
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
// Only charge/discharge current are exposed (both verified round-trip on fw 1.25).
// Every other field (battery type, mode, cut-offs) is preserved verbatim from the
// slot's own program by buildSetProgram(), so a save never changes them.
const CHARGE_MAX = 3000, DISCHARGE_MAX = 2000;   // MC3000 hardware limits (mA)

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
  const el = document.getElementById("editor")!;
  el.innerHTML = `
    <div class="editor">
      <h2>Slot ${slot + 1} — edit program</h2>
      <p class="dev">${p.batteryType} · mode ${p.mode} · ${p.capacityMah} mAh (these are preserved unchanged)</p>
      <label>Charge current (mA)
        <input id="ed-chg" type="number" min="0" max="${CHARGE_MAX}" step="50" value="${p.chargeCurrentMa}"></label>
      <label>Discharge current (mA)
        <input id="ed-dis" type="number" min="0" max="${DISCHARGE_MAX}" step="50" value="${p.dischargeCurrentMa}"></label>
      <div class="controls">
        <button id="ed-save">Save to slot ${slot + 1}</button>
        <button id="ed-cancel">Cancel</button>
      </div>
      <p id="ed-msg" class="status"></p>
    </div>`;
  document.getElementById("ed-cancel")!.addEventListener("click", closeEditor);
  document.getElementById("ed-save")!.addEventListener("click", () => saveEditor(slot, p.raw));
}

async function saveEditor(slot: number, raw: Uint8Array) {
  const msg = (m: string) => { const e = document.getElementById("ed-msg"); if (e) e.textContent = m; };
  const chg = Number((document.getElementById("ed-chg") as HTMLInputElement).value);
  const dis = Number((document.getElementById("ed-dis") as HTMLInputElement).value);
  const bad = (v: number, max: number) => !Number.isInteger(v) || v < 0 || v > max;
  if (bad(chg, CHARGE_MAX) || bad(dis, DISCHARGE_MAX)) {
    msg(`values must be whole mA within 0–${CHARGE_MAX} (charge) / 0–${DISCHARGE_MAX} (discharge)`);
    return;
  }
  msg("writing…");
  try {
    const ack = await withLock(() =>
      request(transport!, buildSetProgram(raw, slot, { chargeCurrentMa: chg, dischargeCurrentMa: dis })));
    if (!isSetProgramAck(ack)) throw new Error(`charger rejected the write (0x${ack[0].toString(16)})`);
    // read back and confirm the values actually took
    const back = parseSlotProgram(await withLock(() => request(transport!, readSlotProgram(slot))));
    if (back.chargeCurrentMa !== chg || back.dischargeCurrentMa !== dis) {
      throw new Error(`read-back mismatch: charger has ${back.chargeCurrentMa}/${back.dischargeCurrentMa} mA`);
    }
    programs[slot] = back;                 // keep chart targets in sync with the edit
    setStatus(`slot ${slot + 1} saved: ${chg} mA charge / ${dis} mA discharge`);
    closeEditor();
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
  renderConnected(t.productName, sys.serial, sys.firmware, sys.hardware);
  await loadPrograms();                  // targets/chemistry for the voltage chart bands
  startPolling();
}

function renderConnected(name: string, serial: string, fw: string, hw: string) {
  h(`
    <h1>openMC3000</h1>
    <p class="dev">${name} · serial ${serial} · firmware ${fw} · hardware ${hw}</p>
    <div class="controls">
      <button id="start">▶ Start (all)</button>
      <button id="stop">■ Stop (all)</button>
    </div>
    <table><tbody id="slots"></tbody></table>
    <p id="status" class="status"></p>
    <div id="editor"></div>
    <div class="chart-head">
      <label>Chart:
        <select id="measure">
          <option value="v">Voltage (V)</option>
          <option value="i">Current (mA)</option>
          <option value="cap">Capacity (mAh)</option>
        </select>
      </label>
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
    <button id="connect">Connect charger</button>
    ${msg ? `<p class="err">${msg}</p>` : ""}
    ${"hid" in navigator ? "" : `<p class="err">This browser has no WebHID. Use desktop Chrome or Edge.</p>`}
  `);
  document.getElementById("connect")!.addEventListener("click", connect);
}

renderDisconnected();
