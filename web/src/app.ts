import "./style.css";
import {
  buildSetProgram, isSetProgramAck, parseLive, parseSlotProgram, parseSystem,
  readLive, readSlotProgram, readSystem, start, stop, type Live,
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

let polling = false;   // guard against overlapping refreshes stacking up
async function refresh() {
  if (polling || !transport) return;
  polling = true;
  try {
    const rows = [];
    let errs = 0;
    for (let s = 0; s < 4; s++) {
      try { rows.push(slotRow(await liveRetry(s))); }
      catch { errs++; rows.push(`<tr><th>Slot ${s + 1}</th><td colspan="6" class="empty">read error, retrying…</td></tr>`); }
    }
    const el = document.getElementById("slots");
    if (el) el.innerHTML = rows.join("");
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
    <p class="note">Start/Stop are global — the MC3000 has no per-slot start over USB/BLE.
       Editing writes charge/discharge current only; other program fields are preserved.</p>
  `);
  document.getElementById("start")!.addEventListener("click", onStart);
  document.getElementById("stop")!.addEventListener("click", onStop);
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
