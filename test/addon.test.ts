import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bridgeEnvironment } from "../bridge/addon-config.mjs";
import { validateDevice } from "../src/transport/hidraw.ts";
import { slotSwitchConfig } from "../bridge/payload.ts";

const valid = {
  mqtt_url: "mqtt://core-mosquitto:1883",
  discovery_prefix: "homeassistant",
  hidraw_path: "/dev/hidraw2",
  enable_control: true,
};

test("add-on default enables control and passes MQTT and USB settings", () => {
  const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
  assert.match(config, /^\s+enable_control: true$/m);
  assert.deepEqual(bridgeEnvironment(valid), {
    MQTT_URL: valid.mqtt_url,
    MQTT_USERNAME: "",
    MQTT_PASSWORD: "",
    DISCOVERY_PREFIX: "homeassistant",
    HIDRAW_PATH: "/dev/hidraw2",
    READ_ONLY: "0",
    BLE_ADDRESS: "",
  });
});

test("read-only setting and credentials are passed to the bridge", () => {
  const env = bridgeEnvironment({
    ...valid, mqtt_url: "mqtts://broker:8883", mqtt_username: "user",
    mqtt_password: "secret", discovery_prefix: "custom/ha", enable_control: false,
  });
  assert.equal(env.READ_ONLY, "1");
  assert.equal(env.MQTT_USERNAME, "user");
  assert.equal(env.MQTT_PASSWORD, "secret");
  assert.equal(env.DISCOVERY_PREFIX, "custom/ha");
});

test("BLE address is optional and passed through", () => {
  const env = bridgeEnvironment({ ...valid, ble_address: "AA:BB:CC:DD:EE:FF" });
  assert.equal(env.BLE_ADDRESS, "AA:BB:CC:DD:EE:FF");
});

test("BLE switch uses slot-specific command and observed state topics", () => {
  const device = { identifiers: ["id"], name: "Charger", manufacturer: "SkyRC", model: "MC3000", sw_version: "1.27" };
  for (let slot = 1; slot <= 4; slot++) {
    const config = slotSwitchConfig(slot, "id", "mc3000/123", "mc3000/123/status", device);
    assert.equal(config.command_topic, `mc3000/123/cmd/slot${slot}/run`);
    assert.equal(config.state_topic, `mc3000/123/slot${slot}/run`);
    assert.equal(config.unique_id, `id_s${slot}_run`);
  }
});

test("invalid settings fail closed", () => {
  for (const invalid of [
    { mqtt_url: "" }, { mqtt_url: "http://broker" },
    { mqtt_url: "mqtt://user:pass@broker" }, { hidraw_path: "/dev/ttyUSB0" },
    { hidraw_path: "/dev/hidraw2/../hidraw0" }, { discovery_prefix: "" },
    { discovery_prefix: "home/+/assistant" }, { enable_control: "true" },
    { mqtt_password: null },
    { ble_address: "not-an-address" },
  ]) {
    assert.throws(() => bridgeEnvironment({ ...valid, ...invalid }));
  }
});

test("explicit USB paths cannot target arbitrary devices", () => {
  assert.throws(() => validateDevice("/dev/ttyUSB0"), /hidraw/);
  assert.throws(() => validateDevice("/dev/hidraw0/../hidraw1"), /hidraw/);
});
