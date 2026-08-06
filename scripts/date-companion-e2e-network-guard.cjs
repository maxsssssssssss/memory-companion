const http = require("node:http");
const https = require("node:https");

const BLOCK_MARKER = "[date-companion-e2e-network] blocked_external_request";

function normalizedHostname(value) {
  return String(value ?? "")
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .split(":")[0]
    .trim()
    .toLowerCase();
}

function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value);
  return (
    hostname === "" ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("127.")
  );
}

function explicitHostname(input) {
  if (input instanceof URL) return input.hostname;
  if (typeof input === "string") {
    try {
      return new URL(input).hostname;
    } catch {
      return "";
    }
  }
  if (input && typeof input === "object") {
    return input.hostname ?? input.host ?? "";
  }
  return "";
}

function rejectExternal(kind, input) {
  const hostname = explicitHostname(input);
  if (isLoopbackHostname(hostname)) return;
  process.stderr.write(`${BLOCK_MARKER} kind=${kind} host=${normalizedHostname(hostname)}\n`);
  throw new Error(`External network access is disabled during date-companion fixture E2E: ${hostname}`);
}

function isNextVersionRegistryRequest(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : input);
    return url.hostname === "registry.npmjs.org" && url.pathname === "/-/package/next/dist-tags";
  } catch {
    return false;
  }
}

function guardRequest(module, methodName, kind) {
  const original = module[methodName];
  module[methodName] = function guardedRequest(...args) {
    rejectExternal(kind, args[0]);
    return original.apply(this, args);
  };
}

guardRequest(http, "request", "http.request");
guardRequest(http, "get", "http.get");
guardRequest(https, "request", "https.request");
guardRequest(https, "get", "https.get");

if (typeof globalThis.fetch === "function") {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function guardedFetch(input, init) {
    if (isNextVersionRegistryRequest(input)) {
      const installed = require("next/package.json").version;
      process.stderr.write("[date-companion-e2e-network] next_version_check_served_locally\n");
      return new Response(JSON.stringify({ latest: installed, canary: installed }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    rejectExternal("fetch", input instanceof Request ? input.url : input);
    return originalFetch(input, init);
  };
}
