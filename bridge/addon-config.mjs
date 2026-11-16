export function bridgeEnvironment(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Add-on options must be an object");
  }
  if (typeof options.mqtt_url !== "string") throw new Error("mqtt_url is required");
  let url;
  try {
    url = new URL(options.mqtt_url);
  } catch {
    throw new Error("mqtt_url must be an mqtt:// or mqtts:// URL");
  }
  if (!["mqtt:", "mqtts:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("mqtt_url must be an mqtt:// or mqtts:// URL without credentials");
  }
  if (typeof options.hidraw_path !== "string" || !/^\/dev\/hidraw\d+$/.test(options.hidraw_path)) {
    throw new Error("hidraw_path must be a host path such as /dev/hidraw0");
  }
  if (typeof options.discovery_prefix !== "string" || !options.discovery_prefix ||
      /[+#\u0000]/.test(options.discovery_prefix)) {
    throw new Error("discovery_prefix must be a non-empty MQTT topic prefix without wildcards");
  }
  if (typeof options.enable_control !== "boolean") throw new Error("enable_control must be a boolean");
  if (options.ble_address !== undefined &&
      (typeof options.ble_address !== "string" ||
       (options.ble_address !== "" && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(options.ble_address)))) {
    throw new Error("ble_address must be empty or a Bluetooth MAC address");
  }
  for (const key of ["mqtt_username", "mqtt_password"]) {
    if (options[key] !== undefined && typeof options[key] !== "string") {
      throw new Error(`${key} must be a string`);
    }
  }
  return {
    MQTT_URL: options.mqtt_url,
    MQTT_USERNAME: options.mqtt_username ?? "",
    MQTT_PASSWORD: options.mqtt_password ?? "",
    DISCOVERY_PREFIX: options.discovery_prefix,
    HIDRAW_PATH: options.hidraw_path,
    READ_ONLY: options.enable_control ? "0" : "1",
    BLE_ADDRESS: options.ble_address ?? "",
  };
}
