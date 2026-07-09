# openMC3000 — portable control & analysis for the SkyRC MC3000

<p align="center">
  <a href="https://glassontin.github.io/openmc3000/"><img src="https://img.shields.io/badge/web%20app-live-38bdf8?style=flat-square&logo=googlechrome&logoColor=white" alt="Web app — live" /></a>
  <img src="https://img.shields.io/badge/WebHID-Chrome%2FEdge-38bdf8?style=flat-square" alt="WebHID" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-orange?style=flat-square" alt="License: AGPL-3.0" /></a>
</p>

Open-source, cross-platform control and analysis software for the **SkyRC MC3000** — a
4-slot charger/analyzer that ships with Windows-only "PC Link" software. openMC3000 talks
to the charger directly over USB-HID; nothing to install for the web app.

**[▶ Open the web app](https://glassontin.github.io/openmc3000/)** — desktop **Chrome/Edge**
over WebHID. Plug the charger in (on its own DC supply), click *Connect*, pick the device.

> It does something even SkyRC's own PC Link and GNU DataExplorer can't: **start and stop a
> charge over USB**, and configure a slot from scratch. DataExplorer declares the `START`/`STOP`
> opcodes but leaves them commented out — they work, and openMC3000 uses them.

## Features

- **Live telemetry** — per-slot voltage, current, capacity, power, and temperature, polled
  once a second.
- **Start / Stop** the charger (global — the MC3000 has no per-slot start over USB).
- **Full slot-program editing** — battery type, mode, capacity, charge/discharge current,
  target & cut-off voltage, termination current. Every field verified to round-trip on
  hardware; the charger clamps to chemistry limits and the result is read back. Plus
  **reset-to-defaults** (chemistry-standard values).
- **Live charts** — per-slot voltage/current/capacity/temperature over a real time axis.
  The voltage chart auto-ranges from the slot's own targets and the cell chemistry, with
  green/amber/red **safety bands** and dashed target/cut-off reference lines.
- **Charge/discharge modelling** — a plain-word state (Bulk CC · Absorption CV · topping
  off · discharging · resting · done), **device-measured internal resistance and energy**,
  plus computed capacity-vs-rated, C-rate, ΔT, peak/avg, and a rough time-remaining estimate.
  Internal resistance is the primary battery-health indicator.
- **Session recording → CSV export** — capture a full charge/discharge curve and download it
  (wide format: `time_iso, elapsed_s`, then `status/V/mA/mAh/°C` per slot) for spreadsheets.

Every protocol claim behind these is marked verified/unverified in [`PROTOCOL.md`](PROTOCOL.md);
the charger used for verification runs firmware 1.25 / hardware 2.2.

## Two front-ends, one codec

The wire protocol (`src/protocol`) and a transport interface (`src/transport`) are shared;
each front-end is a thin consumer:

- **[`web/`](web/)** — the WebHID app above (TypeScript + Vite, no framework). Deploys to
  GitHub Pages on every push.
- **`src/cli.ts`** — a zero-dependency Node CLI over `/dev/hidraw`:

  ```console
  $ npm run cli system
  serial 100083  firmware 1.25  hardware 2.2

  $ npm run cli status
  slot 1: charge    LiIon    3.735V  1005mA 13mAh
  slot 2: standby   LiIon    (empty)

  $ npm run cli start      # …and: watch, stop
  ```

## Running it

**Web app:** just open <https://glassontin.github.io/openmc3000/> in desktop Chrome or Edge
(WebHID is Chromium-desktop only). To hack on it: `cd web && npm install && npm run dev`.

**CLI:** Node 22+ (for `--experimental-strip-types`), no dependencies. On Linux, `/dev/hidraw*`
is root-only by default, so add a udev rule:

```
KERNEL=="hidraw*", ATTRS{idVendor}=="0000", ATTRS{idProduct}=="0001", MODE="0660", GROUP="plugdev"
```

Drop that in `/etc/udev/rules.d/99-skyrc-mc3000.rules`, `udevadm control --reload`, replug.
Note it targets **hidraw**, not `SUBSYSTEM=="usb"` — we speak HID reports, not libusb.

The charger must be powered from its own DC supply; USB does not power it. Its vendor id is
literally `0x0000`, which some hubs refuse to enumerate — use a motherboard port if it
doesn't appear.

## Repo layout

- [`PROTOCOL.md`](PROTOCOL.md) — the wire protocol, with provenance and per-field verification.
- `src/protocol/` — framing, command codec, and decoders (transport-agnostic, shared).
- `src/transport/` — the byte-level seam: `hidraw.ts` (Node) and `webhid.ts` (browser).
- `src/cli.ts` — `status`, `system`, `watch`, `start`, `stop`.
- `web/` — the WebHID app (`npm run dev` / `build`); Pages workflow in `.github/workflows`.
- [`bridge/`](bridge/) — MQTT / Home Assistant bridge (headless telemetry publisher).
- `test/` — `npm test` (node's built-in runner, no framework).

## Safety

`start` begins a real charge/discharge at whatever the slot is programmed for — **know your
cell.** openMC3000 has no protections beyond the charger's own firmware, and while it warns
about chemistry limits it cannot guarantee a program suits the cell you insert.

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
