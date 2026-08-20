import type { IncomingMessage } from "node:http";

import { loadRealtimeGatewayDependenciesAfterEnvironment } from "@/lib/server/voice-qa/realtime-gateway-env";

const {
  requireAuthContext,
  RegistryRealtimeVoiceGatewayRuntimeManager,
  createRealtimeVoiceGatewayServer
} = await loadRealtimeGatewayDependenciesAfterEnvironment(async () => {
  const [auth, runtime, gateway] = await Promise.all([
    import("@/lib/server/auth/request-context"),
    import("@/lib/server/voice-qa/realtime-gateway-runtime"),
    import("@/lib/server/voice-qa/realtime-websocket-gateway")
  ]);
  return {
    requireAuthContext: auth.requireAuthContext,
    RegistryRealtimeVoiceGatewayRuntimeManager:
      runtime.RegistryRealtimeVoiceGatewayRuntimeManager,
    createRealtimeVoiceGatewayServer: gateway.createRealtimeVoiceGatewayServer
  };
});

function requestFromUpgrade(input: IncomingMessage) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const host = input.headers.host ?? "127.0.0.1";
  return new Request(`http://${host}${input.url ?? "/"}`, { headers });
}

function gatewayPort() {
  const parsed = Number(process.env.VOICE_REALTIME_GATEWAY_PORT ?? "3011");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("VOICE_REALTIME_GATEWAY_PORT must be a valid TCP port");
  }
  return parsed;
}

function allowedOrigins() {
  const configured = process.env.VOICE_REALTIME_GATEWAY_ALLOWED_ORIGINS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured?.length
    ? configured
    : ["http://127.0.0.1:3000", "http://localhost:3000"];
}

if (process.env.VOICE_REALTIME_GATEWAY_ENABLED?.toLowerCase() !== "true") {
  throw new Error(
    "Development Realtime Voice gateway is disabled; set VOICE_REALTIME_GATEWAY_ENABLED=true explicitly"
  );
}
if (process.env.VOICE_REALTIME_ENABLED?.toLowerCase() !== "true") {
  throw new Error("VOICE_REALTIME_ENABLED must also be true for the development gateway");
}

const gateway = createRealtimeVoiceGatewayServer({
  authenticate: async (request) => {
    const auth = await requireAuthContext(requestFromUpgrade(request));
    return { userId: auth.user.id, store: auth.store };
  },
  runtimeManager: new RegistryRealtimeVoiceGatewayRuntimeManager(),
  allowedOrigins: allowedOrigins()
});

const address = await gateway.listen({ host: "127.0.0.1", port: gatewayPort() });
console.log(
  `[voice-realtime-gateway] listening ws://127.0.0.1:${address.port}/api/voice/realtime/gateway`
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await gateway.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
