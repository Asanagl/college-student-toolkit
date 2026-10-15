/* eslint-env node */
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const fixtureDir = path.join(root, "tests", "fixtures");
const files = fs
  .readdirSync(fixtureDir)
  .filter((file) => file.endsWith(".html"))
  .map((file) => path.join(fixtureDir, file));
const started = performance.now();
let bytes = 0;
for (let round = 0; round < 100; round += 1) {
  for (const file of files) bytes += fs.statSync(file).size;
}
const elapsed = performance.now() - started;

console.log(
  JSON.stringify({
    fixtureCount: files.length,
    bytesRead: bytes,
    elapsedMs: Number(elapsed.toFixed(2)),
  }),
);
