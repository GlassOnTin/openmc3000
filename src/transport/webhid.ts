/// <reference types="w3c-web-hid" />
import { REPORT_SIZE } from "../protocol/frame.ts";
import type { Transport } from "./transport.ts";

const VID = 0x0000;
const PID = 0x0001;

/**
 * WebHID transport for Chrome/Edge (desktop). Verified against fw 1.25: the device
 * enumerates as 0x0000/0x0001 with one collection (usage 0x1/0x0) and no report IDs,
 * so all traffic uses reportId 0. WebHID is event-driven — inputreports are queued and
 * `receive()` dequeues or waits.
 *
 * `requestDevice()` needs a user gesture, so call `WebHidTransport.request()` from a
 * click handler; it returns null if the user dismisses the chooser.
 */
export class WebHidTransport implements Transport {
  private queue: Uint8Array[] = [];
  private waiter: ((r: Uint8Array) => void) | null = null;
  private readonly onReport = (e: HIDInputReportEvent) => {
    const r = new Uint8Array(e.data.buffer);
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(r); }
    else this.queue.push(r);
  };

  private constructor(private device: HIDDevice) {
    device.addEventListener("inputreport", this.onReport);
  }

  /** Prompt the user to pick the charger, open it, and wrap it. Must run in a user gesture. */
  static async request(): Promise<WebHidTransport | null> {
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
    const device = devices[0];
    if (!device) return null;
    if (!device.opened) await device.open();
    return new WebHidTransport(device);
  }

  async send(report: Uint8Array): Promise<void> {
    // reportId 0 (device has none); report is the full 64-byte payload.
    await this.device.sendReport(0, report);
  }

  async receive(timeoutMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiter = null; resolve(null); }, timeoutMs);
      this.waiter = (r) => { clearTimeout(timer); resolve(r); };
    });
  }

  async drain(): Promise<void> {
    this.queue.length = 0;
  }

  async close(): Promise<void> {
    this.device.removeEventListener("inputreport", this.onReport);
    if (this.device.opened) await this.device.close();
  }

  get productName(): string {
    return this.device.productName ?? "MC3000";
  }
}

export { REPORT_SIZE };
