#!/usr/bin/env -S node --experimental-strip-types
import { parseLive, parseSystem, readLive, readSystem, start, stop } from "./protocol/commands.ts";
import { checkReply } from "./protocol/frame.ts";
import { HidrawTransport } from "./transport/hidraw.ts";
import { request, type Transport } from "./transport/transport.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function live(t: Transport, slot: number) {
  const reply = await request(t, readLive(slot));
  if (!checkReply(reply)) throw new Error(`bad checksum on slot ${slot + 1} reply`);
  return parseLive(reply);
}

function format(l: ReturnType<typeof parseLive>): string {
  const present = l.voltageMv > 0;
  return `slot ${l.slot + 1}: ${l.status.padEnd(9)} ${l.batteryType.padEnd(8)} ` +
    (present
      ? `${(l.voltageMv / 1000).toFixed(3)}V ${String(l.currentMa).padStart(5)}mA ${l.capacityMah}mAh`
      : "(empty)");
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  const t = new HidrawTransport();
  try {
    switch (cmd) {
      case "status": {
        for (let s = 0; s < 4; s++) console.log(format(await live(t, s)));
        break;
      }
      case "system": {
        const s = parseSystem(await request(t, readSystem()));
        console.log(`serial ${s.serial}  firmware ${s.firmware}  hardware ${s.hardware}`);
        break;
      }
      case "watch": {
        for (;;) {
          const rows = [];
          for (let s = 0; s < 4; s++) rows.push(format(await live(t, s)));
          process.stdout.write(`\x1b[H\x1b[J${rows.join("\n")}\n`);
          await sleep(1000);
        }
      }
      case "start":
        await t.send(start());   // no reply; the charger acts silently
        await sleep(1500);       // soft-start ramps over ~7s
        for (let s = 0; s < 4; s++) console.log(format(await live(t, s)));
        break;
      case "stop":
        await t.send(stop());
        await sleep(500);
        for (let s = 0; s < 4; s++) console.log(format(await live(t, s)));
        break;
      default:
        console.error(`usage: mc3000 [status|system|watch|start|stop]`);
        process.exitCode = 2;
    }
  } finally {
    await t.close();
  }
}

await main();
