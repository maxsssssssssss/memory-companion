import { describe, expect, it } from "vitest";
import { appendBoundedMarkerLog } from "./bounded-marker-log.mjs";

const marker = "[date-companion-e2e-network] blocked_external_request";

describe("appendBoundedMarkerLog", () => {
  it("remembers an early marker after its text has been truncated", () => {
    let state = { markerSeen: false, output: "" };
    state = appendBoundedMarkerLog(state, `${marker}\n`, { marker, maxLength: 32 });
    state = appendBoundedMarkerLog(state, "x".repeat(64), { marker, maxLength: 32 });

    expect(state.output).toBe("x".repeat(32));
    expect(state.output).not.toContain(marker);
    expect(state.markerSeen).toBe(true);
  });

  it("detects a marker split across adjacent log chunks", () => {
    let state = { markerSeen: false, output: "" };
    const split = marker.indexOf("blocked");
    state = appendBoundedMarkerLog(state, marker.slice(0, split), { marker, maxLength: 256 });
    state = appendBoundedMarkerLog(state, marker.slice(split), { marker, maxLength: 256 });

    expect(state.markerSeen).toBe(true);
  });
});
