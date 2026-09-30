// Test-process-only guard. Never loaded by the application outside this runner.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { syncBuiltinESMExports } = require("node:module");
const { isLoopbackHostname } = require("./date-companion-e2e-network-guard.cjs");
const repo = path.resolve(process.env.LEARNING_VALIDATION_REPO);
function isLocalEnv(file) {
  if (typeof file !== "string" && !(file instanceof URL)) return false;
  const resolved = path.resolve(String(file));
  return path.dirname(resolved) === repo && /^\.env(?:\.|$)/u.test(path.basename(resolved));
}
const read = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  if (isLocalEnv(file)) { const error = new Error("Local env excluded from synthetic validation"); error.code = "ENOENT"; throw error; }
  return read.call(this, file, ...args);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = args[0];
  const host = typeof options === "object" && options !== null ? options.host : typeof args[1] === "string" ? args[1] : "localhost";
  if (host && !isLoopbackHostname(host)) throw new Error("External socket disabled in learning validation");
  return connect.apply(this, args);
};
syncBuiltinESMExports();
