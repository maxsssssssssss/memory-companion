import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guardPath = resolve(process.cwd(), "scripts/date-companion-e2e-network-guard.cjs");
const probeSource = `
  const guard = require(process.argv[1]);
  const mode = process.argv[2];
  const values = JSON.parse(process.argv[3]);
  const result = values.map((value) => {
    if (mode === "normalized") return guard.normalizedHostname(value);
    if (mode === "loopback") return guard.isLoopbackHostname(value);
    const input = value.kind === "url" ? new URL(value.value) : value.value;
    return guard.explicitHostname(input);
  });
  process.stdout.write(JSON.stringify(result));
`;

function probe(mode, values) {
  const result = spawnSync(
    process.execPath,
    ["-e", probeSource, guardPath, mode, JSON.stringify(values)],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
      windowsHide: true
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `network guard probe exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

describe("date-companion E2E network guard host parsing", () => {
  it("preserves IPv6 while removing only valid brackets and numeric ports", () => {
    expect(probe("normalized", [
      "LOCALHOST:3210",
      "127.0.0.1:8080",
      "::1",
      "[::1]",
      "[::1]:443",
      "[::ffff:8.8.8.8]:443",
      "[::1]:invalid"
    ])).toEqual([
      "localhost",
      "127.0.0.1",
      "::1",
      "::1",
      "::1",
      "::ffff:8.8.8.8",
      "[::1]:invalid"
    ]);
  });

  it("allows only localhost names, 127/8 IPv4, and the IPv6 loopback", () => {
    expect(probe("loopback", [
      "localhost",
      "LOCALHOST:3210",
      "worker.localhost:8443",
      "127.0.0.1",
      "127.255.0.42:65535",
      "::1",
      "[::1]:3210"
    ])).toEqual([true, true, true, true, true, true, true]);
  });

  it("rejects empty, wildcard, lookalike, external, and IPv4-mapped hosts", () => {
    expect(probe("loopback", [
      "",
      "   ",
      "0.0.0.0",
      "8.8.8.8:53",
      "localhost.example",
      "127.example",
      "127.0.0.1.example",
      "::",
      "::ffff:8.8.8.8",
      "[::ffff:8.8.8.8]:443",
      "[::ffff:127.0.0.1]:443"
    ])).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    ]);
  });

  it("extracts URL hostnames and object host:port values without losing IPv6", () => {
    expect(probe("explicit", [
      { kind: "url", value: "http://[::1]:3210/date-companion" },
      { kind: "string", value: "http://worker.localhost:3210/" },
      { kind: "object", value: { host: "[::ffff:8.8.8.8]:443" } },
      { kind: "object", value: { hostname: "127.0.0.2", port: 3210 } },
      { kind: "object", value: {} }
    ])).toEqual([
      "[::1]",
      "worker.localhost",
      "[::ffff:8.8.8.8]:443",
      "127.0.0.2",
      ""
    ]);
  });
});
