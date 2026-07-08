/**
 * One byte-level seam, three implementations: hidraw (Linux/node), WebHID
 * (desktop Chrome), Android USB-host. The protocol layer knows nothing about
 * which one it's talking to.
 */
export interface Transport {
  /** Send a 64-byte output report. */
  send(report: Uint8Array): Promise<void>;
  /** Await the next 64-byte input report, or null on timeout. */
  receive(timeoutMs: number): Promise<Uint8Array | null>;
  /** Discard queued input reports so a reply lines up with its request. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Send a request and await its reply. START/STOP send no reply — don't use this for them. */
export async function request(t: Transport, frame: Uint8Array, timeoutMs = 1000): Promise<Uint8Array> {
  await t.drain();
  await t.send(frame);
  const reply = await t.receive(timeoutMs);
  if (!reply) throw new Error("no reply from charger");
  return reply;
}
