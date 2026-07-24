import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildFrame, checkReply, be16, REPORT_SIZE } from "../src/protocol/frame.ts";
import { readLive, readSlotProgram, readSystem, start, stop, parseLive, parseSystem, parseSlotProgram, buildSetProgram, statusName, isErrorStatus } from "../src/protocol/commands.ts";

const head = (f: Uint8Array, n: number) => Array.from(f.subarray(0, n));

test("frames match the bytes observed on the wire", () => {
  // Cross-checked against DataExplorer MC3000UsbPort.java:69-110 and captured traffic.
  assert.deepEqual(head(readSlotProgram(0), 8), [0x0f, 0x04, 0x5f, 0x00, 0x00, 0x5f, 0xff, 0xff]);
  assert.deepEqual(head(readSlotProgram(1), 8), [0x0f, 0x04, 0x5f, 0x00, 0x01, 0x60, 0xff, 0xff]);
  assert.deepEqual(head(readSlotProgram(3), 8), [0x0f, 0x04, 0x5f, 0x00, 0x03, 0x62, 0xff, 0xff]);
  assert.deepEqual(head(readLive(0), 8),        [0x0f, 0x04, 0x55, 0x00, 0x00, 0x55, 0xff, 0xff]);
  assert.deepEqual(head(readLive(2), 8),        [0x0f, 0x04, 0x55, 0x00, 0x02, 0x57, 0xff, 0xff]);
  assert.deepEqual(head(readSystem(), 8),       [0x0f, 0x04, 0x5a, 0x00, 0x00, 0x5a, 0xff, 0xff]);
  assert.deepEqual(head(start(), 7),            [0x0f, 0x03, 0x05, 0x00, 0x05, 0xff, 0xff]);
  assert.deepEqual(head(stop(), 7),             [0x0f, 0x03, 0xfe, 0x00, 0xfe, 0xff, 0xff]);
});

test("frames are padded to one 64-byte report", () => {
  assert.equal(buildFrame(0x55, [0, 0]).length, REPORT_SIZE);
  assert.equal(start().length, REPORT_SIZE);
});

test("reply checksum covers bytes 0..62", () => {
  const r = new Uint8Array(REPORT_SIZE);
  r[0] = 0x55; r[8] = 0x0e; r[9] = 0x29;
  r[63] = (0x55 + 0x0e + 0x29) & 0xff;
  assert.ok(checkReply(r));
  r[63] ^= 0xff;
  assert.ok(!checkReply(r));
});

test("parseLive decodes a real idle-slot reply", () => {
  // Captured from hardware: slot 1, LiIon, standby, 3.625V, no current.
  const r = new Uint8Array(REPORT_SIZE);
  r.set([0x55, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0e, 0x29], 0);
  const l = parseLive(r);
  assert.equal(l.slot, 0);
  assert.equal(l.batteryType, "LiIon");
  assert.equal(l.status, "standby");
  assert.equal(l.voltageMv, 3625);
  assert.equal(l.currentMa, 0);
});

test("be16 is big-endian", () => {
  assert.equal(be16(new Uint8Array([0x0e, 0x29]), 0), 3625);
});

test("parseLive extracts power on fw 1.25 (captured under load)", () => {
  // Captured 2026-07-08 fw1.25: slot 1 charging, 3.646V/826mA, power 0x0bc7=3015mW.
  const r = new Uint8Array(REPORT_SIZE);
  r.set([0x55,0x00,0x00,0x00,0x00,0x01,0x00,0x06,0x0e,0x3e,0x03,0x3a,0x00,0x00,
         0x01,0x30,0x00,0x16,0x01,0x2c,0x00,0x02,0x0b,0xc7], 0);
  const l = parseLive(r);
  assert.equal(l.voltageMv, 3646);
  assert.equal(l.currentMa, 826);
  assert.equal(l.status, "charge");
  assert.equal(l.powerMw, 3015);              // == round(3.646 * 826)
  assert.equal(l.temperatureRaw, 304);
});

test("parseSystem decodes firmware 1.25 SYSTEM reply", () => {
  // Captured 2026-07-08 straight from the device.
  const r = new Uint8Array(REPORT_SIZE);
  r.set([0x5a,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x01,0x00,0x00,0x01,0xf8,
         0x31,0x30,0x30,0x30,0x38,0x33,0x01,0x00,0x00,0x00,0x00,0x01,0x19,0x16,0x00,0xa3], 0);
  const s = parseSystem(r);
  assert.equal(s.serial, "100083");
  assert.equal(s.firmware, "1.25");
  assert.equal(s.hardware, "2.2");
  assert.equal(s.beepOn, true);          // byte 9 = 0x01
  assert.equal(s.tempUnit, "C");         // byte 8 = 0x00
  assert.deepEqual(s.hiddenChem, ["LiIo4.35"]);  // byte 11 = 0x01
});

test("buildSetProgram repacks the read reply into the verified write frame (fw 1.25)", () => {
  // Captured 2026-07-08: slot 1 SLOT_PROGRAM (0x5F) read reply and the identity
  // write frame the device acked with 0xF0.
  const read = new Uint8Array(REPORT_SIZE);
  read.set([0x5f,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xe8,0x01,0xf4,0x0c,0xe4,0x10,0x68,0x00,
            0x64,0x01,0xf4,0x01,0x00,0x00,0x03,0x03,0x00,0x00,0x2d,0x00,0xb4,0x00,0x00,0x00], 0);
  const w = buildSetProgram(read, 0);
  const expect = [0x0f,0x20,0x11,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xe8,0x01,0xf4,0x0c,0xe4,0x10,
                  0x68,0x00,0x64,0x01,0xf4,0x01,0x00,0x00,0x00,0x03,0x03,0x00,0x2d,0x00,0xb4,0x00,
                  0x00,0x9a,0xff,0xff];
  assert.deepEqual(Array.from(w.subarray(0, 36)), expect);
});

test("buildSetProgram charge-current override changes only bytes 9,10 and checksum", () => {
  const read = new Uint8Array(REPORT_SIZE);
  read.set([0x5f,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xe8,0x01,0xf4,0x0c,0xe4,0x10,0x68,0x00,
            0x64,0x01,0xf4,0x01,0x00,0x00,0x03,0x03,0x00,0x00,0x2d,0x00,0xb4,0x00,0x00,0x00], 0);
  const base = buildSetProgram(read, 0);
  const mod = buildSetProgram(read, 0, { chargeCurrentMa: 650 });
  assert.equal((mod[9] << 8) | mod[10], 650);        // 0x028a
  const diffs = [];
  for (let i = 0; i < 36; i++) if (base[i] !== mod[i]) diffs.push(i);
  assert.deepEqual(diffs, [9, 10, 33]);               // current hi/lo + checksum only
});

test("parseSlotProgram decodes the captured slot-1 program (fw 1.25)", () => {
  const r = new Uint8Array(REPORT_SIZE);
  r.set([0x5f,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xe8,0x01,0xf4,0x0c,0xe4,0x10,0x68,0x00,
         0x64,0x01,0xf4,0x01,0x00,0x00,0x03,0x03,0x00,0x00,0x2d,0x00,0xb4,0x00,0x00,0x00], 0);
  const p = parseSlotProgram(r);
  assert.equal(p.slot, 0);
  assert.equal(p.batteryType, "LiIon");
  assert.equal(p.mode, 0);
  assert.equal(p.chargeCurrentMa, 1000);      // 0x03e8
  assert.equal(p.dischargeCurrentMa, 500);    // 0x01f4
  assert.equal(p.dischargeCutMv, 3300);       // 0x0ce4
  assert.equal(p.chargeEndMv, 4200);          // 0x1068
});

test("status byte: running states, named and raw error codes", () => {
  assert.equal(statusName(0), "standby");
  assert.equal(statusName(1), "charge");
  assert.equal(statusName(4), "finish");
  assert.equal(statusName(0x87), "timer cut");        // seen on the MC3000 display, fw 1.25
  assert.equal(statusName(0x85), "error(0x85)");      // in the error range, not yet identified
  assert.equal(statusName(0x30), "unknown(0x30)");    // out of both ranges
  assert.ok(isErrorStatus(0x87) && isErrorStatus(0x80) && !isErrorStatus(4));
});

test("buildSetProgram cut-time override writes bytes 29-30 (read 27-28)", () => {
  const read = new Uint8Array(REPORT_SIZE);
  read.set([0x5f,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0xe8,0x01,0xf4,0x0c,0xe4,0x10,0x68,0x00,
            0x64,0x01,0xf4,0x01,0x00,0x00,0x03,0x03,0x00,0x00,0x2d,0x00,0xb4,0x00,0x00,0x00], 0);
  assert.equal(parseSlotProgram(read).cutTimeMin, 180);          // read bytes 27-28 = 0,180
  const w = buildSetProgram(read, 0, { cutTimeMin: 990 });
  assert.equal((w[29] << 8) | w[30], 990);
  // checksum stays valid after the override
  let sum = 0; for (let i = 2; i <= 32; i++) sum += w[i];
  assert.equal(w[33], sum & 0xff);
});

test("bridge payload: stateJson + HA discovery from a captured LIVE frame", async () => {
  const { METRICS, stateJson, discoveryConfig } = await import("../bridge/payload.ts");
  // captured under-load: charge, 3.646V, 826mA, 30.4C, 22mΩ
  const r = new Uint8Array(REPORT_SIZE);
  r.set([0x55,0x00,0x00,0x00,0x00,0x01,0x00,0x06,0x0e,0x3e,0x03,0x3a,0x00,0x00,
         0x01,0x30,0x00,0x16,0x01,0x2c,0x00,0x02,0x0b,0xc7], 0);
  const s = stateJson(parseLive(r));
  assert.equal(s.voltage, "3.646");
  assert.equal(s.current, "0.826");
  assert.equal(s.power, "3.01");          // V·I, not the device's stale power field
  assert.equal(s.temperature, "30.4");
  assert.equal(s.resistance, 22);
  assert.equal(s.status, "charge");
  const dev = { identifiers: ["mc3000_100083"], name: "SkyRC MC3000", manufacturer: "SkyRC", model: "MC3000", sw_version: "1.25" };
  const cfg = discoveryConfig(METRICS[0], 1, "mc3000_100083", "mc3000/100083", "mc3000/100083/status", dev);
  assert.equal(cfg.state_topic, "mc3000/100083/slot1");
  assert.equal(cfg.value_template, "{{ value_json.voltage }}");
  assert.equal(cfg.device_class, "voltage");
  assert.equal(cfg.unit_of_measurement, "V");
});

test("bridge control: switch + number discovery configs", async () => {
  const { switchConfig, numberConfig } = await import("../bridge/payload.ts");
  const dev = { identifiers: ["mc3000_100083"], name: "SkyRC MC3000", manufacturer: "SkyRC", model: "MC3000", sw_version: "1.25" };
  const sw = switchConfig("mc3000_100083", "mc3000/100083", "mc3000/100083/status", dev);
  assert.equal(sw.command_topic, "mc3000/100083/cmd/run");
  assert.equal(sw.state_topic, "mc3000/100083/run");
  assert.equal(sw.payload_on, "ON");
  const num = numberConfig(4, "mc3000_100083", "mc3000/100083", "mc3000/100083/status", dev);
  assert.equal(num.command_topic, "mc3000/100083/cmd/slot4/charge_current");
  assert.equal(num.state_topic, "mc3000/100083/set/slot4/charge_current");
  assert.equal(num.max, 3000);
  assert.equal(num.unit_of_measurement, "mA");
});
