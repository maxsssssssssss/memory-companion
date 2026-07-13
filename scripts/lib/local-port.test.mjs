import net from "node:net";
import { describe, expect, it } from "vitest";
import { assertLocalPortAvailable, localPortUnavailableMessage } from "./local-port.mjs";

function listenOnRandomLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: address.port });
    });
  });
}

describe("local port validation", () => {
  it("rejects a port that already has a local server", async () => {
    const { server, port } = await listenOnRandomLocalPort();
    try {
      await expect(assertLocalPortAvailable(port)).rejects.toThrow(
        `Port ${port} is unavailable`
      );
    } finally {
      server.close();
    }
  });

  it("treats access-denied listen errors as an unavailable port", () => {
    expect(localPortUnavailableMessage(3201, { code: "EACCES" })).toBe(
      "Port 3201 is unavailable. Stop the existing dev server or choose another --port."
    );
  });
});
