import "./style.css";
import {
  parseLive, parseSystem, readLive, readSystem, start, stop, type Live,
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
  return `<tr class="${charging ? "charging" : ""}"><th>Slot ${l.slot + 1}</th>${cells}</tr>`;
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
    <p class="note">Start/Stop are global — the MC3000 has no per-slot start over USB/BLE.</p>
  `);
  document.getElementById("start")!.addEventListener("click", onStart);
  document.getElementById("stop")!.addEventListener("click", onStop);
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
