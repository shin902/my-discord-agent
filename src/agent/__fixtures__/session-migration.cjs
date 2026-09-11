const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
require("tsx/cjs/api").register();

process.env.SESSIONS_DIR = workerData.root;
const gate = new Int32Array(workerData.gate);
const pragma = Database.prototype.pragma;
let paused = false;
let recheckedInTransaction = false;
Database.prototype.pragma = function (...args) {
  const value = pragma.apply(this, args);
  if (paused && args[0] === "user_version") {
    recheckedInTransaction = this.inTransaction;
  }
  if (!paused && args[0] === "user_version" && value === workerData.version) {
    paused = true;
    parentPort.postMessage("stale-version-read");
    // Allow another connection to finish upgrading before this open continues.
    Atomics.wait(gate, 0, 0);
  }
  return value;
};

const { appendMessage } = require("../session.ts");
appendMessage(workerData.group, "worker-session", {
  role: "user",
  content: "worker message",
  timestamp: 2,
}).then(
  () => parentPort.postMessage({ status: "appended", recheckedInTransaction }),
  (error) => parentPort.postMessage({ error: String(error) }),
);
