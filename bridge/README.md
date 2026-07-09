# openMC3000 — MQTT / Home Assistant bridge

A small headless service that polls the MC3000 over USB-HID (reusing the repo's codec) and
publishes per-slot telemetry to MQTT with **Home Assistant auto-discovery** — HA creates the
entities itself, no YAML.

Per slot it publishes: voltage, current, capacity, power (V·I), energy, temperature,
internal resistance, and status. Grouped under one HA device (`SkyRC MC3000`, keyed by the
charger's serial), with an availability topic so entities show *unavailable* when the bridge
stops.

**Read-only** — it publishes telemetry only; it never starts/stops or reconfigures the
charger. The charger is a single **exclusive** USB consumer: run the bridge **or** the web
app / CLI, not both at once.

## Run

```sh
npm install                       # once

# dry-run (no broker) — prints the exact topics + payloads it would publish
npm start

# against your broker
MQTT_URL=mqtt://192.168.0.x:1883 MQTT_USERNAME=user MQTT_PASSWORD=pass npm start
```

Config (env): `MQTT_URL` (unset → dry-run), `MQTT_USERNAME`, `MQTT_PASSWORD`,
`POLL_MS` (default 2000), `DISCOVERY_PREFIX` (default `homeassistant`).

Needs the same Linux hidraw udev rule as the CLI (see the top-level README). To run it as a
service, point a systemd unit or a container at `npm start` with the env set.

## Topics

- Discovery: `homeassistant/sensor/mc3000_<serial>/s<N>_<metric>/config` (retained)
- State: `mc3000/<serial>/slot<N>` — one JSON object per slot, e.g.
  `{"voltage":"3.646","current":"0.826","power":"3.01","energy":"0.002","temperature":"30.4","resistance":22,"status":"charge",…}`
- Availability: `mc3000/<serial>/status` = `online` / `offline`
