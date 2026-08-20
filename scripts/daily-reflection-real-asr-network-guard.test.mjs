import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const guard = require("./daily-reflection-real-asr-network-guard.cjs");

function serverConfiguration() {
  return {
    mode: "server",
    target: guard.normalizeProviderTarget("https://transcribe.example.test/v1"),
    auditPath: "unused",
    budgetDir: "unused"
  };
}

describe("Daily Reflection real ASR exact network guard", () => {
  it("is inactive by default and requires a positive mode", () => {
    expect(guard.readConfiguration({})).toEqual({ mode: "disabled" });
  });

  it("normalizes all accepted adapter base forms without duplicating v1", () => {
    for (const value of [
      "https://transcribe.example.test",
      "https://transcribe.example.test/v1",
      "https://transcribe.example.test/v1/v1",
      "https://transcribe.example.test/v1/audio/transcriptions"
    ]) {
      expect(guard.normalizeProviderTarget(value)).toMatchObject({
        origin: "https://transcribe.example.test",
        path: "/v1/audio/transcriptions"
      });
    }
  });

  it("allows only exact provider POST plus loopback and rejects every near miss", () => {
    const configuration = serverConfiguration();
    const exact = guard.effectiveRequest(
      "https://transcribe.example.test/v1/audio/transcriptions",
      { method: "POST" },
      "https:"
    );
    expect(guard.classifyRequest(exact, configuration)).toEqual({
      allowed: true,
      kind: "provider_submit"
    });
    for (const [url, method] of [
      ["https://transcribe.example.test/v1/audio/transcriptions", "GET"],
      ["https://transcribe.example.test/v1/audio/transcriptions?token=secret", "POST"],
      ["https://transcribe.example.test/v1/audio/transcriptions/", "POST"],
      ["https://lookalike.transcribe.example.test/v1/audio/transcriptions", "POST"]
    ]) {
      expect(guard.classifyRequest(
        guard.effectiveRequest(url, { method }, "https:"),
        configuration
      ).allowed).toBe(false);
    }
    expect(guard.classifyRequest(
      guard.effectiveRequest("http://127.0.0.1:3000/date-companion", {}, "http:"),
      configuration
    )).toEqual({ allowed: true, kind: "loopback" });
  });

  it("honors Request init and Node URL option overrides", () => {
    const request = new Request("https://transcribe.example.test/v1/audio/transcriptions", {
      method: "GET"
    });
    expect(guard.effectiveRequest(request, { method: "POST" }, "https:").method).toBe("POST");
    const overridden = guard.effectiveRequest(
      new URL("https://transcribe.example.test/v1/audio/transcriptions"),
      { hostname: "blocked.example.test", method: "POST" },
      "https:"
    );
    expect(overridden.url.hostname).toBe("blocked.example.test");
  });

  it("enforces a process-shared two-submit budget before transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "dr31-budget-"));
    try {
      const configuration = { budgetDir: root };
      expect(guard.claimSubmitSlot(configuration)).toBe(1);
      expect(guard.claimSubmitSlot(configuration)).toBe(2);
      expect(guard.claimSubmitSlot(configuration)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts URLs, credentials, query values, and raw error details from audit events", () => {
    const sentinel = "do-not-log-this-secret";
    const serialized = JSON.stringify(guard.safeEvent({
      event: "request_blocked",
      kind: "blocked",
      reason: "external_origin_not_allowed",
      url: `https://${sentinel}:password@example.test/path?token=${sentinel}`,
      authorization: sentinel,
      error: sentinel
    }));
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("example.test");
    expect(serialized).not.toContain("password");
  });

  it("emits the compact submit classification consumed by the ledger", () => {
    expect(guard.safeEvent({ event: "request_start", kind: "provider_submit", slot: 1 }))
      .toMatchObject({ event: "request_start", classification: "submit", slot: 1 });
  });
});
