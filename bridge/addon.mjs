import { readFileSync } from "node:fs";
import { bridgeEnvironment } from "./addon-config.mjs";

try {
  const options = JSON.parse(readFileSync("/data/options.json", "utf8"));
  Object.assign(process.env, bridgeEnvironment(options));
  await import("./bridge.ts");
} catch (error) {
  console.error("Add-on startup failed:", error.message);
  process.exitCode = 1;
}
