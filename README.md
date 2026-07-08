# openMC3000 — portable control for the SkyRC MC3000

Open-source control software for the **SkyRC MC3000** charger/analyzer (a 4-slot
charger that ships with Windows-only PC Link software).

## Status — protocol codec, Linux CLI, and a WebHID browser app, verified on hardware.

The device is a USB-HID device (`0000:0001`) using 64-byte interrupt reports; see
[`PROTOCOL.md`](PROTOCOL.md), which marks every claim as verified or unverified.

Two front-ends share one codec (`src/protocol`, `src/transport`):
- **`src/cli.ts`** — Node CLI over `/dev/hidraw` (`status`, `system`, `watch`, `start`, `stop`).
- **[`web/`](web/)** — zero-install WebHID app for desktop Chrome/Edge: connect, live per-slot
  telemetry, global start/stop. Verified in Chrome — enumeration, `SYSTEM` readback and live
  polling confirmed on hardware; start/stop send the same frames the CLI verified.

**It can start and stop a charge.** GNU DataExplorer — the only existing cross-platform
MC3000 tool — declares the `START`/`STOP` opcodes but leaves the calls commented out, so
it can only log a program you began at the front panel. Those opcodes work:

```console
$ npm run cli status
slot 1: standby   LiIon    3.625V     0mA 1mAh
slot 2: standby   LiIon    (empty)

$ npm run cli start
slot 1: charge    LiIon    3.625V     0mA 0mAh    # current ramps over ~7s

$ npm run cli stop
slot 1: standby   LiIon    3.624V     0mA 0mAh
```

## Requirements

Node 22+ (for `--experimental-strip-types`). No dependencies.

Access to the device needs a udev rule — `/dev/hidraw*` is root-only by default:

```
KERNEL=="hidraw*", ATTRS{idVendor}=="0000", ATTRS{idProduct}=="0001", MODE="0660", GROUP="plugdev"
```

Drop that in `/etc/udev/rules.d/99-skyrc-mc3000.rules`, `udevadm control --reload`, replug.
Note this targets **hidraw**, not `SUBSYSTEM=="usb"` — we speak HID reports, not libusb.

The charger must be powered from its own DC supply; USB does not power it. Its vendor id
is literally `0x0000`, which some hubs refuse to enumerate — use a motherboard port.

## Repo layout

- [`PROTOCOL.md`](PROTOCOL.md) — the wire protocol, with provenance and verification status.
- `src/protocol/` — framing and command codec, transport-agnostic.
- `src/transport/` — the byte-level seam. `hidraw.ts` today; WebHID and Android USB-host
  are the reason the seam exists.
- `src/cli.ts` — `status`, `watch`, `start`, `stop`.
- `test/` — `npm test` (node's built-in runner, no framework).

## Safety

`start` begins a real charge at whatever current the slot is programmed for. Know your
cell. This software has no thermal runaway protections beyond the charger's own; it does
not validate that a slot's program suits the cell you put in it.

## Legal

Independent interoperability implementation, from two sources — **neither of them SkyRC's
proprietary software**:

- **GNU DataExplorer** (GPL-3.0-or-later): its MC3000 plugin was read openly for the wire
  framing, command codes and field offsets. This is an openly-credited GPL derivative — not
  clean-room — and GPLv3 §13 permits combining it into this AGPL-3.0 work. Facts are cited
  by file and line in [`PROTOCOL.md`](PROTOCOL.md); no code was copied.
- **Direct observation of the device**: values confirmed by writing a known setting over
  USB-HID and reading it back.

No SkyRC binary or firmware was decompiled, disassembled, or copied, and no SkyRC code,
resources, or firmware are included or derived from. The documented items — command codes,
register offsets, wire framing — come from DataExplorer and from observing the device's own
USB-HID interface; they are interface facts, not copyrightable expression.

"SkyRC" and "MC3000" are trademarks of SkyRC Technology Co., Ltd. This project is independent
and not affiliated with or endorsed by them.

Licensed under **GNU AGPL-3.0-or-later** (see `LICENSE`).

    Copyright (C) 2026 Ian Williams
