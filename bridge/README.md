# openMC3000 — MQTT / Home Assistant bridge

A small headless service that polls the MC3000 over USB-HID (reusing the repo's codec) and
publishes per-slot telemetry to MQTT with **Home Assistant auto-discovery** — HA creates the
entities itself, no YAML.

For Home Assistant OS installation and USB setup, see [the add-on instructions](../DOCS.md).
Both the add-on and standalone bridge default to control enabled. Set
`enable_control: false` in the add-on for telemetry only.

Per slot it publishes: voltage, current, capacity, power (V·I), energy, temperature,
internal resistance, and status. Grouped under one HA device (`SkyRC MC3000`, keyed by the
charger's serial), with an availability topic so entities show *unavailable* when the bridge
stops.

It also exposes **control** to Home Assistant: a **Charging switch** (on → START all occupied
slots, off → STOP — the known USB command has no slot selection) and a **per-slot charge-current number**
(writes SET_PROGRAM). Set `READ_ONLY=1` to publish telemetry only.
With `BLE_ADDRESS` configured, four additional switches control the individual slots via
BLE while USB continues to supply telemetry. They never change the programmed values.
BLE needs Python, `bleak` and access to a local Bluetooth adapter. `BLE_PYTHON` selects
the Python executable (default `python3`). The address must be the same physical charger
as the USB device; the bridge cannot verify this. See the [safety instructions](../DOCS.md).

The charger is a single **exclusive** USB consumer: run the bridge **or** the web app / CLI,
not both at once.

> ⚠ With control enabled, a Home Assistant automation can start a real charge on every
> occupied slot at its programmed current; changing a current writes the slot program.
> Know your cells. Restrict command topics to trusted MQTT clients and do not retain
> commands. On subscription the bridge ignores retained messages, but a newly
> published retained command can still be delivered live.

## Run

```sh
npm install                       # once

# dry-run (no broker) — prints the exact topics + payloads it would publish
npm start

# against your broker
MQTT_URL=mqtt://192.168.0.x:1883 MQTT_USERNAME=user MQTT_PASSWORD=pass npm start
```

Config (env): `MQTT_URL` (unset → dry-run), `MQTT_USERNAME`, `MQTT_PASSWORD`,
`POLL_MS` (default 2000), `DISCOVERY_PREFIX` (default `homeassistant`), `READ_ONLY`,
and `HIDRAW_PATH` (optional explicit `/dev/hidrawN`, checked against USB ID
`0000:0001` before opening), `BLE_ADDRESS` (optional Bluetooth MAC), and `BLE_PYTHON`.
In read-only mode the bridge removes retained control
discovery messages under its configured prefix.

Needs the same Linux hidraw udev rule as the CLI (see the top-level README). To run it as a
service, point a systemd unit or a container at `npm start` with the env set.

## Topics

- Discovery: `homeassistant/sensor/mc3000_<serial>/s<N>_<metric>/config` (retained)
- State: `mc3000/<serial>/slot<N>` — one JSON object per slot, e.g.
  `{"voltage":"3.646","current":"0.826","power":"3.01","energy":"0.002","temperature":"30.4","resistance":22,"status":"charge",…}`
- Availability: `mc3000/<serial>/status` = `online` / `offline`
- Control discovery: `homeassistant/switch/mc3000_<serial>/run/config`,
  `homeassistant/number/mc3000_<serial>/s<N>_charge_current/config`, and, with BLE
  enabled, `homeassistant/switch/mc3000_<serial>/s<N>_run/config` (retained)
- Commands (in): `mc3000/<serial>/cmd/run` = `ON`/`OFF`,
  `mc3000/<serial>/cmd/slot<N>/charge_current` = mA,
  `mc3000/<serial>/cmd/slot<N>/run` = `ON`/`OFF` (BLE)
- Control state (out): `mc3000/<serial>/run` = `ON`/`OFF`,
  `mc3000/<serial>/set/slot<N>/charge_current` = mA,
  `mc3000/<serial>/slot<N>/run` = `ON`/`OFF` (USB observed state)
