import { closeSync, constants, openSync, readSync, writeSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { REPORT_SIZE } from "../protocol/frame.ts";
import type { Transport } from "./transport.ts";

const VID = 0x0000;
const PID = 0x0001;

/** Find the charger's /dev/hidraw* by walking sysfs. Its VID is literally 0x0000. */
export function findDevice(): string {
  for (const name of readdirSync("/sys/class/hidraw")) {
    const uevent = readFileSync(`/sys/class/hidraw/${name}/device/uevent`, "utf8");
    const m = uevent.match(/HID_ID=\w+:0*([0-9A-Fa-f]+):0*([0-9A-Fa-f]+)/);
    if (m && parseInt(m[1], 16) === VID && parseInt(m[2], 16) === PID) return `/dev/${name}`;
  }
  throw new Error("MC3000 not found — is it plugged in and powered from its own DC supply?");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * O_NONBLOCK + poll. Node has no poll(2) binding, and a blocking readSync on a
 * quiet hidraw node would hang the process — START/STOP never reply.
 * ponytail: 5ms poll beats pulling in node-hid for this.
 */
export class HidrawTransport implements Transport {
  private fd: number;

  constructor(path: string = findDevice()) {
    this.fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK);
  }

  async send(report: Uint8Array): Promise<void> {
    writeSync(this.fd, report, 0, report.length);
  }

  private readOnce(): Uint8Array | null {
    const buf = Buffer.alloc(REPORT_SIZE);
    try {
      const n = readSync(this.fd, buf, 0, REPORT_SIZE, null);
      return n > 0 ? new Uint8Array(buf.subarray(0, n)) : null;
    } catch (e: any) {
      if (e.code === "EAGAIN") return null;
      throw e;
    }
  }

  async receive(timeoutMs: number): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const r = this.readOnce();
      if (r) return r;
      await sleep(5);
    } while (Date.now() < deadline);
    return null;
  }

  async drain(): Promise<void> {
    while (this.readOnce()) { /* discard */ }
  }

  async close(): Promise<void> {
    closeSync(this.fd);
  }
}
