#!/usr/bin/env node
// Only installed in the disposable integration-test image.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.includes("--dump-json")) {
  process.stdout.write(
    JSON.stringify({
      id: "fixture",
      title: "Runtime YouTube fixture",
      channel: "fixture",
    }),
  );
} else if (args.some((arg) => arg.includes("v=hang"))) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await writeFile("/tmp/tool-runtime-child.pid", String(child.pid));
  await new Promise((resolve) => child.once("exit", resolve));
}
