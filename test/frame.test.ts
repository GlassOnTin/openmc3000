import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildFrame, checkReply, be16, REPORT_SIZE } from "../src/protocol/frame.ts";
import { readLive, readSlotProgram, readSystem, start, stop, parseLive } from "../src/protocol/commands.ts";

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
