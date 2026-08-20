const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const path = require("node:path");

const MODE_ENV = "DR_REAL_ASR_NETWORK_GUARD_MODE";
const SERVER_MODE = "server";
const LOOPBACK_MODE = "loopback_only";
const REQUIRED_SUBMIT_BUDGET = 2;
const INSTALL_SYMBOL = Symbol.for("daily-reflection-real-asr-network-guard.installed");
const BLOCK_MARKER = "[daily-reflection-real-asr-network] blocked_request";

function normalizedHostname(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return raw;
    const suffix = raw.slice(close + 1);
    return suffix === "" || /^:\d+$/u.test(suffix) ? raw.slice(1, close) : raw;
  }
  if (net.isIP(raw) === 6) return raw;
  const colon = raw.indexOf(":");
  if (colon >= 0 && colon === raw.lastIndexOf(":") && /^\d+$/u.test(raw.slice(colon + 1))) {
    return raw.slice(0, colon);
  }
  return raw;
}

function isLoopbackHostname(value) {
  const hostname = normalizedHostname(value);
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") return true;
  return net.isIP(hostname) === 4 && hostname.split(".", 1)[0] === "127";
}

function normalizeProviderTarget(rawBaseUrl) {
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error("dedicated_transcription_base_url_invalid");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("dedicated_transcription_base_url_protocol_invalid");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("dedicated_transcription_base_url_components_invalid");
  }
  let pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\/v1\/v1(?=\/|$)/gu, "/v1");
  if (!pathname.endsWith("/audio/transcriptions")) {
    pathname = pathname.endsWith("/v1")
      ? `${pathname}/audio/transcriptions`
      : `${pathname}/v1/audio/transcriptions`;
  }
  pathname = pathname.replace(/^\/\//u, "/");
  return {
    baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`,
    origin: parsed.origin,
    path: pathname.startsWith("/") ? pathname : `/${pathname}`
  };
}

function methodFrom(input, overrides, fallbackMethod = "GET") {
  if (overrides && typeof overrides === "object" && overrides.method) {
    return String(overrides.method).toUpperCase();
  }
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  if (input && typeof input === "object" && !(input instanceof URL) && input.method) {
    return String(input.method).toUpperCase();
  }
  return fallbackMethod;
}

function applyRequestOverrides(url, overrides) {
  if (!overrides || typeof overrides !== "object") return url;
  if (overrides.auth) throw new Error("request_userinfo_not_allowed");
  const next = new URL(url.href);
  if (overrides.protocol) next.protocol = overrides.protocol;
  if (overrides.hostname && overrides.host) throw new Error("ambiguous_request_host");
  if (overrides.hostname) next.hostname = overrides.hostname;
  if (overrides.host) {
    const host = new URL(`${next.protocol}//${overrides.host}`);
    next.hostname = host.hostname;
    next.port = host.port;
  }
  if (overrides.port !== undefined && overrides.port !== null && String(overrides.port) !== "") {
    next.port = String(overrides.port);
  }
  const rawPath = overrides.path ?? overrides.pathname;
  if (rawPath !== undefined) {
    const parsedPath = new URL(String(rawPath), `${next.origin}/`);
    next.pathname = parsedPath.pathname;
    next.search = parsedPath.search;
    next.hash = parsedPath.hash;
  }
  return next;
}

function effectiveRequest(input, overrides, defaultProtocol = "http:", fallbackMethod = "GET") {
  let url;
  if (input instanceof URL) {
    url = new URL(input.href);
  } else if (typeof Request !== "undefined" && input instanceof Request) {
    url = new URL(input.url);
  } else if (typeof input === "string") {
    url = new URL(input);
  } else if (input && typeof input === "object") {
    if (input.hostname && input.host) throw new Error("ambiguous_request_host");
    const protocol = input.protocol ?? defaultProtocol;
    const host = input.hostname ?? input.host;
    if (!host) throw new Error("request_host_missing");
    url = new URL(`${protocol}//${host}${input.port ? `:${input.port}` : ""}${input.path ?? input.pathname ?? "/"}`);
    if (input.auth) throw new Error("request_userinfo_not_allowed");
    overrides = undefined;
  } else {
    throw new Error("request_url_unparseable");
  }
  url = applyRequestOverrides(url, overrides);
  return { url, method: methodFrom(input, overrides, fallbackMethod) };
}

function safeEvent(input) {
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event: input.event,
    classification: input.kind === "provider_submit" ? "submit" : input.kind,
    ...(typeof input.slot === "number" ? { slot: input.slot } : {}),
    ...(input.statusClass ? { status_class: input.statusClass } : {}),
    ...(typeof input.elapsedMs === "number" ? { elapsed_ms: input.elapsedMs } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  };
}

function appendAudit(configuration, event) {
  fs.appendFileSync(configuration.auditPath, `${JSON.stringify(safeEvent(event))}\n`, "utf8");
}

function readConfiguration(environment = process.env) {
  const mode = environment[MODE_ENV]?.trim() || "disabled";
  if (!["disabled", SERVER_MODE, LOOPBACK_MODE].includes(mode)) {
    throw new Error("network_guard_mode_invalid");
  }
  if (mode === "disabled") return { mode };
  if (mode === LOOPBACK_MODE) return { mode };
  const dedicatedBaseUrl = environment.OPENAI_TRANSCRIBE_BASE_URL?.trim();
  const dedicatedApiKey = environment.OPENAI_TRANSCRIBE_API_KEY?.trim();
  const auditPath = environment.DR_REAL_ASR_NETWORK_AUDIT_PATH?.trim();
  const budgetDir = environment.DR_REAL_ASR_SUBMIT_BUDGET_DIR?.trim();
  if (!dedicatedBaseUrl || !dedicatedApiKey || !auditPath || !budgetDir) {
    throw new Error("network_guard_server_config_missing");
  }
  if (environment.OPENAI_BASE_URL?.trim() || environment.OPENAI_API_KEY?.trim()) {
    throw new Error("generic_openai_credentials_not_allowed");
  }
  if (environment.TRANSCRIPTION_PROVIDER?.trim() !== "openai") {
    throw new Error("network_guard_openai_provider_required");
  }
  if (environment.TRANSCRIPTION_FALLBACK_PROVIDER?.trim() !== "none") {
    throw new Error("network_guard_fallback_must_be_none");
  }
  if (environment.OPENAI_MAX_RETRIES?.trim() !== "0") {
    throw new Error("network_guard_retries_must_be_zero");
  }
  if (environment.DR_REAL_ASR_MAX_SUBMITS?.trim() !== String(REQUIRED_SUBMIT_BUDGET)) {
    throw new Error("network_guard_budget_must_equal_two");
  }
  if (!fs.existsSync(path.dirname(auditPath)) || !fs.existsSync(budgetDir)) {
    throw new Error("network_guard_owned_directory_missing");
  }
  return {
    mode,
    target: normalizeProviderTarget(dedicatedBaseUrl),
    auditPath,
    budgetDir
  };
}

function classifyRequest(request, configuration) {
  const { url, method } = request;
  if (url.username || url.password) return { allowed: false, kind: "blocked", reason: "userinfo_not_allowed" };
  if (configuration.mode === LOOPBACK_MODE) {
    return isLoopbackHostname(url.hostname)
      ? { allowed: true, kind: "loopback" }
      : { allowed: false, kind: "blocked", reason: "external_origin_not_allowed" };
  }
  if (url.origin === configuration.target.origin) {
    const exact = method === "POST"
      && url.pathname === configuration.target.path
      && url.search === ""
      && url.hash === "";
    return exact
      ? { allowed: true, kind: "provider_submit" }
      : { allowed: false, kind: "blocked", reason: "provider_request_not_exact" };
  }
  return isLoopbackHostname(url.hostname)
    ? { allowed: true, kind: "loopback" }
    : { allowed: false, kind: "blocked", reason: "external_origin_not_allowed" };
}

function claimSubmitSlot(configuration) {
  for (let slot = 1; slot <= REQUIRED_SUBMIT_BUDGET; slot += 1) {
    const claim = path.join(configuration.budgetDir, `submit-${slot}.claim`);
    try {
      const descriptor = fs.openSync(claim, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      fs.closeSync(descriptor);
      return slot;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return null;
}

function exactNextRegistryRequest(input, init) {
  try {
    const request = effectiveRequest(input, init, "https:", "GET");
    return request.method === "GET"
      && request.url.href === "https://registry.npmjs.org/-/package/next/dist-tags";
  } catch {
    return false;
  }
}

function installGuard(environment = process.env) {
  const configuration = readConfiguration(environment);
  if (configuration.mode === "disabled") return configuration;
  if (globalThis[INSTALL_SYMBOL]) return configuration;
  globalThis[INSTALL_SYMBOL] = true;
  if (configuration.mode === SERVER_MODE) {
    appendAudit(configuration, { event: "guard_ready", kind: "guard" });
  }

  function authorize(request) {
    const classification = classifyRequest(request, configuration);
    if (!classification.allowed) {
      if (configuration.mode === SERVER_MODE) {
        appendAudit(configuration, { event: "request_blocked", ...classification });
      }
      process.stderr.write(`${BLOCK_MARKER} reason=${classification.reason}\n`);
      throw new Error(`daily_reflection_real_asr_network_blocked:${classification.reason}`);
    }
    if (classification.kind !== "provider_submit") return classification;
    const slot = claimSubmitSlot(configuration);
    if (slot === null) {
      appendAudit(configuration, {
        event: "request_blocked",
        kind: "blocked",
        reason: "submit_budget_exhausted"
      });
      throw new Error("daily_reflection_real_asr_submit_budget_exhausted");
    }
    appendAudit(configuration, { event: "request_start", kind: classification.kind, slot });
    return { ...classification, slot };
  }

  function wrapRequest(module, methodName, defaultProtocol, fallbackMethod) {
    const original = module[methodName];
    module[methodName] = function guardedRequest(...args) {
      let request;
      try {
        request = effectiveRequest(args[0], args[1], defaultProtocol, fallbackMethod);
      } catch (error) {
        process.stderr.write(`${BLOCK_MARKER} reason=request_url_unparseable\n`);
        throw new Error("daily_reflection_real_asr_network_blocked:request_url_unparseable");
      }
      const started = Date.now();
      const classification = authorize(request);
      const outgoing = original.apply(this, args);
      if (classification.kind === "provider_submit") {
        let settled = false;
        const settle = (event) => {
          if (settled) return;
          settled = true;
          appendAudit(configuration, {
            ...event,
            kind: classification.kind,
            slot: classification.slot,
            elapsedMs: Date.now() - started
          });
        };
        outgoing.once("response", (response) => settle({
          event: "request_end",
          statusClass: `${Math.floor(response.statusCode / 100)}xx`
        }));
        outgoing.once("error", () => settle({ event: "request_error", reason: "transport_error" }));
      }
      return outgoing;
    };
  }

  wrapRequest(http, "request", "http:", "GET");
  wrapRequest(http, "get", "http:", "GET");
  wrapRequest(https, "request", "https:", "GET");
  wrapRequest(https, "get", "https:", "GET");

  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function guardedFetch(input, init) {
      if (configuration.mode === SERVER_MODE && exactNextRegistryRequest(input, init)) {
        const installed = require("next/package.json").version;
        appendAudit(configuration, { event: "local_stub", kind: "next_version_check" });
        return new Response(JSON.stringify({ latest: installed, canary: installed }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      const request = effectiveRequest(input, init, "https:", "GET");
      const started = Date.now();
      const classification = authorize(request);
      try {
        const response = await originalFetch(input, { ...init, redirect: "manual" });
        if (classification.kind === "provider_submit") {
          appendAudit(configuration, {
            event: "request_end",
            kind: classification.kind,
            slot: classification.slot,
            statusClass: `${Math.floor(response.status / 100)}xx`,
            elapsedMs: Date.now() - started
          });
        }
        return response;
      } catch (error) {
        if (classification.kind === "provider_submit") {
          appendAudit(configuration, {
            event: "request_error",
            kind: classification.kind,
            slot: classification.slot,
            reason: "transport_error",
            elapsedMs: Date.now() - started
          });
        }
        throw error;
      }
    };
  }
  return configuration;
}

if (process.env[MODE_ENV]?.trim() && process.env[MODE_ENV].trim() !== "disabled") {
  installGuard();
}

module.exports = {
  BLOCK_MARKER,
  REQUIRED_SUBMIT_BUDGET,
  claimSubmitSlot,
  classifyRequest,
  effectiveRequest,
  installGuard,
  isLoopbackHostname,
  normalizeProviderTarget,
  normalizedHostname,
  readConfiguration,
  safeEvent
};
