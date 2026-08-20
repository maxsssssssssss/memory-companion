// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  loadRealtimeGatewayDependenciesAfterEnvironment,
  loadRealtimeGatewayEnvironment
} from "./realtime-gateway-env";

describe("loadRealtimeGatewayEnvironment", () => {
  it("loads the default local env file without exposing its contents", () => {
    const loadFile = vi.fn();
    const result = loadRealtimeGatewayEnvironment({
      environment: {},
      cwd: "C:\\workspace",
      fileExists: () => true,
      loadFile
    });

    expect(result).toEqual({ loaded: true, explicit: false });
    expect(loadFile).toHaveBeenCalledOnce();
    expect(loadFile.mock.calls[0]?.[0]).toMatch(/\.env\.local$/u);
  });

  it("allows shell-only configuration when the default file is absent", () => {
    expect(loadRealtimeGatewayEnvironment({
      environment: { VOICE_REALTIME_ENABLED: "true" },
      fileExists: () => false
    })).toEqual({ loaded: false, explicit: false });
  });

  it("fails closed when an explicitly selected env file is missing", () => {
    expect(() => loadRealtimeGatewayEnvironment({
      environment: { VOICE_REALTIME_GATEWAY_ENV_FILE: "missing.env" },
      fileExists: () => false
    })).toThrow("VOICE_REALTIME_GATEWAY_ENV_FILE does not exist");
  });

  it("loads the standalone environment before importing stateful dependencies", async () => {
    const order: string[] = [];
    const result = await loadRealtimeGatewayDependenciesAfterEnvironment(
      async () => {
        order.push("dependencies");
        return "ready";
      },
      {
        environment: {},
        fileExists: () => true,
        loadFile: () => order.push("environment")
      }
    );

    expect(result).toBe("ready");
    expect(order).toEqual(["environment", "dependencies"]);
  });
});
