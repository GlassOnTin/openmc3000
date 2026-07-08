# SkyRC MC3000 — protocol notes

Interoperability notes for the MC3000's USB-HID control protocol.

**Provenance.** Two sources, **neither of them SkyRC's proprietary software**:

1. **[GNU DataExplorer](https://www.nongnu.org/dataexplorer/) 4.0.6** (GPL-3.0-or-later,
   `SkyRC/src/gde/device/skyrc/`) — read openly for the framing, command codes and field
   offsets, then verified byte-for-byte against the hardware. Facts are cited by file and
   line; no code was copied. This is a credited GPL derivative — *not* clean-room — and
   GPLv3 §13 permits combining it into this AGPL-3.0-or-later work.
2. **Direct probing of the device** — write a known value, read it back, match the bytes.

No SkyRC binary or firmware was decompiled, disassembled, or copied, and no SkyRC code,
resources, or firmware are included or derived from. Everything below is either taken from
DataExplorer (above) or established by observing the **device's** own USB-HID interface —
interface facts (command codes, register offsets, wire framing), not copyrightable
expression.

Each claim below is marked **[verified]** (observed on hardware) or **[unverified]**.
Hardware used: MC3000 **firmware 1.25, hardware 2.2** (verified 2026-07-08). Several LIVE
fields are firmware-gated; facts here are from 1.25 unless noted.

## Transport

USB HID, VID `0x0000` / PID `0x0001` — a deliberately invalid vendor id; some hub and
xHCI firmware silently refuses to enumerate it, so prefer a motherboard port. **[verified]**

One interface, two 64-byte interrupt endpoints: `0x01 OUT`, `0x81 IN`. No report IDs, so
the report number is `0` on WebHID and hidraw writes carry no prefix byte. **[verified]**

The HID report descriptor declares Usage Page `0x01` (Generic Desktop), Usage `0x00`
(undefined) — not one of Chrome's protected usages, so WebHID should expose it. **[unverified:
not yet tried in a browser]**

libusb is **not** required. DataExplorer claims the interface via usbfs, but plain
`/dev/hidraw*` reads and writes work identically. **[verified]**

## Frame format

**Request (host→device)** — one 64-byte OUT report, zero-padded:

```
0F           header
len          bytes from `cmd` through `cksum` inclusive  (1 + data.length + 1)
cmd          command code
<data…>      len - 2 bytes
cksum        sum(cmd, …data) & 0xFF
FF FF        terminator
```

**Reply (device→host)** — one 64-byte IN report:

```
[0]      command code, echoed
[1..62]  payload
[63]     cksum = sum(bytes[0..62]) & 0xFF
```

Note the asymmetry: a request's checksum covers only `cmd`+`data`, while a reply's covers
the whole 63-byte prefix. **[verified]**

Multi-byte integers are big-endian throughout. **[verified]**

## Commands

| Code   | Name           | Request                      | Reply |
|--------|----------------|------------------------------|-------|
| `0x05` | START          | `0F 03 05 00 05 FF FF`       | none  |
| `0x11` | SET_PROGRAM    | `0F 20 11 00 …32 bytes…`     | `0xF0` ack |
| `0x55` | LIVE           | `0F 04 55 00 <slot> <ck> FF FF` | telemetry |
| `0x5A` | SYSTEM         | `0F 04 5A 00 00 5A FF FF`    | system settings |
| `0x5F` | SLOT_PROGRAM   | `0F 04 5F 00 <slot> <ck> FF FF` | slot program |
| `0xFE` | STOP           | `0F 03 FE 00 FE FF FF`       | none  |

`slot` is 0-based. START/STOP are **[verified]**; SET_PROGRAM's 32-byte layout is
**[unverified]** — taken from DataExplorer `MC3000UsbPort.java:290` and kolinger's
`mc3000usb.py`, never exercised here.

### START / STOP

START begins whatever program is loaded in each occupied slot; STOP halts all slots.
Neither elicits a reply — the charger acts silently, so poll `LIVE` to observe the
transition. **[verified]**

DataExplorer declares both opcodes but leaves the calls commented out
(`MC3000UsbPort.java:183-230`), and its author's comment reads *"stop the data collection
not really processing"*. That comment is wrong, or at least incomplete: on firmware as
shipped, `0x05` puts an occupied slot into `status=1 (charge)` and current ramps to the
programmed setpoint. Measured on a 21700 LiIon at a 1000 mA setpoint: **[verified]**

```
t+0.0s  status=1  3.624V     0mA      soft-start
t+2.5s  status=1  3.625V    67mA
t+5.0s  status=1  3.637V   529mA
t+7.5s  status=1  3.650V  1001mA      at setpoint
STOP →  status=0  3.643V     0mA
```

The ramp takes ~7 s, so a poll sooner than that will read a misleadingly low current.

### LIVE reply (`0x55`)

Offsets cross-checked against `MC3000.convertDataBytes()` and `MC3000.java:1608,1643,1655`.

| Offset | Field | Notes |
|--------|-------|-------|
| `0`    | `0x55` echo | |
| `1`    | slot number | 0-based **[verified]** |
| `2`    | battery type | `0=LiIon 1=LiFe 2=LiIo4.35 3=NiMH 4=NiCd 5=NiZn 6=Eneloop 7=RAM` **[verified for LiIon]** |
| `3`    | mode | `0=Charge 1=Refresh 2=Storage/Break-in 3=Discharge 4=Cycle` **[unverified]** |
| `5`    | status | `0=standby 1=charge 2=discharge 3=resting 4=finish`, `0x80+`=error **[verified for 0,1]** |
| `8..9`   | voltage, mV | **[verified]** |
| `10..11` | current, mA | **[verified]** |
| `12..13` | capacity, mAh | **[verified]** |
| `14..15` | temperature | `304` idle at room temp (≈30.4 °C), unchanged under brief load; **[verified present]**, 0.1 °C scale **[unverified]** (no reference thermometer). Earlier "315" reads were stale (undrained queue), not a different offset. |
| `16..17` | resistance? | `0` idle, `22` under load; **[verified present]**, mΩ scale **[unverified]** |
| `18..19` | — | reads `300`; **[unverified]** |
| `20..21` | energy | firmware ≥ 1.05; `2` under load **[unverified]** |
| `22..23` | **power, mW** | firmware ≥ 1.05; **[verified]** — read `3015` mW at 3.646 V × 826 mA (= 3.01 W). Exact match to U·I. |
| `24`     | capacity decimal | firmware ≥ 1.11; `5` under load **[unverified]** |
| `25..26` | — | firmware ≥ 1.14; `3634` under load **[unverified]** |

Verified on firmware 1.25. Idle reads must drain the input queue first — an undrained
read returns the previous report and produces plausible-but-wrong values (this is how the
"315" temperature confusion arose).

### SYSTEM reply (`0x5A`)

A 16-byte machine-ID block sits at **offset 16** of the reply
(`MC3000.java:113`, `machineId[i] = buffer[i+16]`), so its fields are at reply offsets
`16+n`:

| machineId offset | reply offset | Field | Notes |
|--------|--------|-------|-------|
| `0..5`   | `16..21` | machine id / serial, ASCII | e.g. `"100083"` **[verified present]** |
| `11`     | `27`     | firmware major | **[verified]** — read `1` |
| `12`     | `28`     | firmware minor | **[verified]** — read `0x19` = 25, i.e. firmware **1.25** |
| `13`     | `29`     | hardware version | `hw = b/10 . b%10`; read `0x16` = 22 → **2.2** **[verified]** |

The firmware version gates several LIVE fields (see above), so read SYSTEM first.

Note: the SYSTEM reply does **not** pass the LIVE trailing-checksum rule (byte 63 is
padding here); it carries its checksum differently — offset **[unverified]**, but the
version and serial decode cleanly, so the reply itself is sound.

### SLOT_PROGRAM reply (`0x5F`)

`[1]` slot, `[2]` busy tag, `[3]` battery type, `[4]` operation mode, then big-endian u16
fields: `[5]` capacity mAh, `[7]` charge current mA, `[9]` discharge current mA, `[11]`
discharge cut-off mV, `[13]` charge end voltage mV, `[15]` charge end current mA, `[17]`
discharge reduce current mA; `[19]` cycle count, `[20]` charge resting time, `[21]` cycle
mode, `[22]` peak sense voltage, `[23]` trickle current, `[24..25]` restart voltage mV,
`[26]` cut temperature, `[27..28]` cut time, `[29]` temperature unit, `[30]` trickle time,
`[31]` discharge resting time.

Verified for slot 1 only: LiIon / Charge / 1000 mA / 500 mA / 3000 mV cut-off / 4200 mV
end. The remaining fields are **[unverified]** and are taken from kolinger's decoder.

## Gaps worth capturing

These need a USB capture of SkyRC's Windows PC Link app driving the charger:

- SET_PROGRAM's exact 32-byte layout and its `0xF0` ack.
- SYSTEM settings reply layout (firmware version lives here; several LIVE fields are
  gated on it).
- Temperature and resistance scaling.
- Whether per-slot start/stop exists, or only the global `0x05`/`0xFE`.
- The firmware-update path.

## Credits

- [GNU DataExplorer](https://www.nongnu.org/dataexplorer/) (GPL-3.0-or-later) — framing,
  command codes, LIVE field offsets, and the START/STOP opcodes it never wired up.
- [kolinger/skyrc-mc3000](https://github.com/kolinger/skyrc-mc3000) — slot-program decode.
