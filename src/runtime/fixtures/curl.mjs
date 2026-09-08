#!/usr/bin/env node
// Only installed in the disposable integration-test image.
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const url = args.at(-1);
if (url.includes("failure")) {
  console.error("fixture fetch failed");
  process.exit(7);
}
const text = url.includes("large")
  ? "artifact-line\n".repeat(20_000)
  : "# Runtime web fixture";
if (args.includes("-o")) {
  await writeFile(output, text);
  process.stdout.write("200");
} else process.stdout.write(text);
