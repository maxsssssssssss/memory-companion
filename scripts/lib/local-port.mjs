import net from "node:net";

export function localPortUnavailableMessage(port, error) {
  if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
    return `Port ${port} is unavailable. Stop the existing dev server or choose another --port.`;
  }
  return null;
}

export function assertLocalPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      const unavailableMessage = localPortUnavailableMessage(port, error);
      if (unavailableMessage) {
        reject(new Error(unavailableMessage));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve());
    });
  });
}
