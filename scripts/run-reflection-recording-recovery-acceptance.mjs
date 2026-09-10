import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

// Independent acceptance only: reuse the existing Next/Playwright configuration
// and loopback guard. No product routes or Provider selection code are replaced.
const root = resolve(process.cwd());
const runId = `${Date.now()}-${process.pid}`;
const dataDir = resolve(root, `.data/reflection-recovery-acceptance-${runId}`);
const artifactDir = resolve(root, `output/playwright/reflection-recovery-acceptance-${runId}`);
const dist = `.next-reflection-recovery-acceptance-${runId}`;
const config = `tsconfig.reflection-recovery-acceptance-${runId}.json`;
const fixturePath = resolve(dataDir, "synthetic-90s.webm");
const guard = resolve(root, "scripts/date-companion-e2e-network-guard.cjs").replaceAll("\\", "/");
const nextEnvPath = resolve(root, "next-env.d.ts");
const nextEnvBefore = await readFile(nextEnvPath);
const requestedGrep = process.argv[2];
const require = createRequire(import.meta.url);
const startedAt = Date.now();
const result = { runId, dataDir, artifactDir, testsExit: null, externalRequests: 0,
  candidateRequests: 0, organizerRequests: 0, fixtureErrors: 0,
  nextPortReleased: false, fixturePortReleased: false, nextEnvRestored: false };
let held = false;
const pending = new Set();
let logWrites = Promise.resolve();
const log = (name, chunk) => {
  logWrites = logWrites.then(() => appendFile(resolve(artifactDir, name), chunk));
};
const progress = (n, message) => console.log(`[reflection-recovery-acceptance] ${n}/4 ${message}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function listen(server, port = 0) {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}
async function released(port) {
  const server = net.createServer();
  try { await listen(server, port); await new Promise((done) => server.close(done)); return true; }
  catch { return false; }
}
function responsePayload(request) {
  const text = request.input.find((message) => message.role === "user")?.content;
  if (typeof text !== "string") throw new Error("fixture_missing_input");
  const start = text.indexOf('{"candidates":');
  if (start >= 0) {
    result.organizerRequests++;
    const candidate = JSON.parse(text.slice(start)).candidates[0];
    if (!candidate?.id) throw new Error("fixture_missing_candidate");
    return { items: [{ cardKind: "insight", proposedTitle: "合成录音验收",
      proposedText: candidate.text, sourceCandidateIds: [candidate.id], clusterTitle: "离线夹具",
      confidence: 0.9, importance: 0.5, durability: 0.5, novelty: 0.5,
      epistemicStatus: "reported_event", riskFlags: [] }] };
  }
  result.candidateRequests++;
  const segment = text.match(/^\[([^\]]+)\] [\d.]+-[\d.]+s: (.+)$/mu);
  if (!segment) throw new Error("fixture_missing_segment");
  return { items: [{ candidateKind: "insight", proposedText: segment[2],
    evidenceIds: [segment[1]], confidence: 0.9, caution: "仅合成验收输入" }] };
}
const provider = createServer(async (req, res) => {
  const json = (value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    if (req.url === "/control/hold" && req.method === "POST") { held = true; json({ held }); return; }
    if (req.url === "/control/release" && req.method === "POST") {
      held = false; for (const release of pending) release(); pending.clear(); json({ held }); return;
    }
    if (req.url === "/control/status" && req.method === "GET") {
      json({ heldRequests: pending.size, candidateRequests: result.candidateRequests, organizerRequests: result.organizerRequests }); return;
    }
    if (req.url !== "/v1/responses" || req.method !== "POST") { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const payload = responsePayload(input);
    if (held) await new Promise((release) => pending.add(release));
    json({ id: "resp_local_fixture", object: "response", status: "completed",
      output: [{ id: "msg_local_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(payload), annotations: [] }] }] });
  } catch {
    result.fixtureErrors++; res.writeHead(500); res.end('{"error":"local_fixture_contract_error"}');
  }
});
let next;
let playwright;
let port;
let providerPort;
function child(command, args, env, filename) {
  const processChild = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  processChild.on("error", (error) => { processChild.spawnFailureCode = error.code ?? "spawn_error"; });
  for (const stream of [processChild.stdout, processChild.stderr]) stream.on("data", (chunk) => {
    const value = chunk.toString();
    if (value.includes("blocked_external_request")) result.externalRequests++;
    log(filename, value);
    if (filename === "playwright.log") process.stdout.write(value);
  });
  return processChild;
}
async function stop(processChild) {
  if (!processChild || processChild.exitCode !== null || !processChild.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(processChild.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else processChild.kill("SIGTERM");
  for (let attempt = 0; attempt < 20 && processChild.exitCode === null; attempt++) await pause(100);
}
await mkdir(dataDir, { recursive: true });
await mkdir(artifactDir, { recursive: true });
await writeFile(resolve(artifactDir, "next-env.before.txt"), nextEnvBefore);
try {
  progress(0, "creating synthetic audio and isolated fixture environment");
  const audio = spawnSync(require("ffmpeg-static"), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
    "-i", "anullsrc=r=48000:cl=mono", "-t", "90", "-codec:a", "libopus", "-b:a", "24k",
    "-application", "voip", "-ac", "1", "-ar", "48000", "-f", "webm", fixturePath],
  { windowsHide: true, stdio: "pipe", timeout: 120000 });
  if (audio.status !== 0) throw new Error(`synthetic_audio_failed:${audio.error?.code ?? audio.status}`);
  providerPort = await listen(provider);
  port = await freePort();
  const env = { ...process.env };
  // Explicit blank values prevent local .env files from enabling remote clients.
  for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|BASE_URL|PROXY)$/u.test(key)) env[key] = "";
  Object.assign(env, {
    NODE_OPTIONS: `--require=${guard}`, NEXT_TELEMETRY_DISABLED: "1", APP_DATA_DIR: dataDir,
    APP_STORAGE_MODE: "local", PIPELINE_EXECUTION_MODE: "inline", REDIS_URL: "",
    DAILY_BRIEF_INVITE_CODES: "reflection-e2e", DAILY_REFLECTION_UPLOAD_ENABLED: "true",
    DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: "true", DAILY_BRIEF_TOY_SYNC_ENABLED: "false",
    DAILY_REFLECTION_TOY_SYNC_ENABLED: "false", TRANSCRIPTION_PROVIDER: "fixture", TRANSCRIPTION_FALLBACK_PROVIDER: "none",
    EXTRACTION_PROVIDER: "rule", EXTRACTION_FALLBACK_PROVIDER: "none", AUDIO_INSIGHT_PROVIDER: "rule", AUDIO_INSIGHT_FALLBACK_PROVIDER: "none",
    RELATIONSHIP_SIGNAL_PROVIDER: "none", RELATIONSHIP_SIGNAL_FALLBACK_PROVIDER: "none", EMOTION_SIGNAL_PROVIDER: "none",
    PROACTIVE_INSIGHT_PROVIDER: "none", MEMORY_RELEVANCE_PROVIDER: "none", QA_HYBRID_RETRIEVAL_MODE: "off",
    QA_HIERARCHICAL_NAVIGATION_MODE: "off", VOICEPRINT_SELF_ENROLLMENT_ENABLED: "false", MEMORY_OWNER_REVIEW_ENABLED: "false",
    DATE_COMPANION_MEMORY_BRIDGE_ENABLED: "false", DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "false",
    DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET: "", LLM_PROVIDER: "", QA_PROVIDER: "", VOICE_QA_LLM_PROVIDER: "",
    OPENAI_API_KEY: "synthetic-local-fixture", OPENAI_BASE_URL: `http://127.0.0.1:${providerPort}/v1`,
    OPENAI_TEXT_MODEL: "local-fixture", OPENAI_ORG_ID: "", OPENAI_PROJECT_ID: "", OPENAI_MAX_RETRIES: "0",
    OPENAI_REQUEST_TIMEOUT_MS: "60000", OPENROUTER_API_KEY: "", OPENROUTER_BASE_URL: "",
    OPENROUTER_HTTP_REFERER: "", OPENROUTER_APP_TITLE: "", DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "",
    VLLM_BASE_URL: "", HYBRID_EMBEDDING_BASE_URL: "", SPEAKER_ASR_BASE_URL: "", SPEAKER_ASR_AUDIO_BASE_URL: "",
    SPEAKER_ASR_AUDIO_ACCESS_TOKEN: "", VOICEPRINT_BASE_URL: "", FRP_PUBLIC_BASE_URL: "",
    DAILY_BRIEF_E2E_DIST_DIR: dist, DAILY_BRIEF_E2E_TSCONFIG: config,
    DATE_COMPANION_E2E_BASE_URL: `http://127.0.0.1:${port}`,
    DATE_COMPANION_E2E_ARTIFACT_DIR: artifactDir, DATE_COMPANION_E2E_SPEC: "reflection-recording-recovery-acceptance.spec.ts",
    REFLECTION_ACCEPTANCE_DATA: dataDir, REFLECTION_ACCEPTANCE_AUDIO: fixturePath,
    REFLECTION_ACCEPTANCE_ARTIFACTS: artifactDir, REFLECTION_ACCEPTANCE_PROVIDER: `http://127.0.0.1:${providerPort}`
  });
  await writeFile(resolve(root, config), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { incremental: false },
    include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", "e2e/reflection-recording-recovery-acceptance.spec.ts", `${dist}/types/**/*.ts`] }, null, 2));
  next = child(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], env, "next.log");
  const deadline = Date.now() + 120000;
  let ready = false;
  while (Date.now() < deadline) {
    if (next.spawnFailureCode) throw new Error(`next_spawn_failed:${next.spawnFailureCode}`);
    if (next.exitCode !== null) throw new Error("next_exited_before_ready");
    try { ready = (await fetch(`${env.DATE_COMPANION_E2E_BASE_URL}/reflection`, { signal: AbortSignal.timeout(5000) })).ok; } catch { /* bounded readiness polling */ }
    if (ready) break;
    await pause(500);
  }
  if (!ready) throw new Error("next_readiness_timeout");
  progress(1, `local Next ready; running ${requestedGrep ? "selected" : "4"} independent browser/HTTP cases`);
  playwright = child(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.date-companion.config.ts",
    ...(requestedGrep ? ["--grep", requestedGrep] : [])], env, "playwright.log");
  result.testsExit = await new Promise((done, reject) => { playwright.once("error", reject); playwright.once("exit", (code) => done(code ?? 1)); });
  progress(2, `browser/HTTP batch finished exit=${result.testsExit}`);
} catch (error) {
  result.error = error instanceof Error ? error.message : "acceptance_runner_error";
  process.exitCode = 1;
} finally {
  await stop(playwright);
  await stop(next);
  held = false; for (const release of pending) release(); pending.clear();
  if (provider.listening) { provider.closeAllConnections(); await new Promise((done) => provider.close(done)); }
  result.nextPortReleased = port ? await released(port) : true;
  result.fixturePortReleased = providerPort ? await released(providerPort) : true;
  const current = await readFile(nextEnvPath);
  const withoutGeneratedImport = (value) => value.toString("utf8").replace(
    /^(?:import ["']\.\/[^\r\n]*\/types\/routes\.d\.ts["'];?|\/\/\/ <reference path="\.\/[^\r\n]*\/types\/routes\.d\.ts" \/>)\r?\n/gmu, "");
  if (!current.equals(nextEnvBefore) && withoutGeneratedImport(current) === withoutGeneratedImport(nextEnvBefore)) await writeFile(nextEnvPath, nextEnvBefore);
  result.nextEnvRestored = (await readFile(nextEnvPath)).equals(nextEnvBefore);
  for (const ownPath of [resolve(root, dist), resolve(root, config)]) {
    const withinRoot = relative(root, ownPath);
    if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot) || !withinRoot.includes(runId)) throw new Error("unsafe_cleanup_target");
    await rm(ownPath, { recursive: true, force: true });
  }
  result.durationMs = Date.now() - startedAt;
  await logWrites;
  await writeFile(resolve(artifactDir, "result.json"), JSON.stringify(result, null, 2));
  await writeFile(resolve(root, "output/reflection-recording-recovery-independent-run.json"), JSON.stringify(result, null, 2));
  progress(3, `owned listeners stopped; next-env restored=${result.nextEnvRestored}`);
  if (result.testsExit !== 0 || result.externalRequests || result.fixtureErrors || !result.nextPortReleased || !result.fixturePortReleased || !result.nextEnvRestored) process.exitCode = 1;
  progress(4, `finished exit=${process.exitCode ?? 0}; artifacts=${artifactDir}`);
}
