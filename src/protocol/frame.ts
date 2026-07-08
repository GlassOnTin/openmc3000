/**
 * MC3000 wire framing.
 *
 * Request (host->device), padded to a 64-byte HID output report:
 *   0F  len  cmd  <data...>  cksum  FF FF
 *
 *   len   = number of bytes from `cmd` through `cksum` inclusive (1 + data.length + 1)
 *   cksum = sum(cmd, ...data) & 0xFF
 *
 * Reply (device->host), a 64-byte HID input report:
 *   cmd  <payload...>                             byte 63 = sum(bytes[0..62]) & 0xFF
 *
 * Note the asymmetry: request checksums cover only cmd+data, reply checksums
 * cover the whole 63-byte prefix. Both verified against hardware.
 */

export const REPORT_SIZE = 64;

export function buildFrame(cmd: number, data: readonly number[] = []): Uint8Array {
  const body = [cmd, ...data];
  const cksum = body.reduce((a, b) => a + b, 0) & 0xff;
  const frame = [0x0f, body.length + 1, ...body, cksum, 0xff, 0xff];
  if (frame.length > REPORT_SIZE) throw new Error(`frame too long: ${frame.length}`);
  const out = new Uint8Array(REPORT_SIZE);
  out.set(frame);
  return out;
}

/** Reply checksum covers bytes 0..62; byte 63 carries it. */
export function checkReply(report: Uint8Array): boolean {
  if (report.length !== REPORT_SIZE) return false;
  let sum = 0;
  for (let i = 0; i < REPORT_SIZE - 1; i++) sum += report[i];
  return (sum & 0xff) === report[REPORT_SIZE - 1];
}

/** Big-endian u16 at `offset`. The device is big-endian throughout. */
export const be16 = (b: Uint8Array, offset: number): number => (b[offset] << 8) | b[offset + 1];
