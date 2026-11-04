// Local acceptance launcher only. Real model output is never replaced or injected.
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";

const root = process.cwd();
const id = new Date().toISOString().replace(/[:.]/gu, "-");
const resumeArgument = process.argv.find(value => value.startsWith("--resume="));
const p3 = process.argv.includes("--p3");
const reuseArgument = process.argv.find(value => value.startsWith("--reuse-build="));
const resume = Boolean(resumeArgument), development = process.argv.includes("--dev");
if (p3 && (!reuseArgument || development)) throw new Error("thinking_p3_current_production_build_required");
const evidenceRoot = resolve(root, p3 ? "output/reflection-thinking-p3-real" : "output/reflection-thinking-p1-real");
const evidence = resume ? resolve(root, resumeArgument.slice("--resume=".length)) : resolve(evidenceRoot, id);
const localEvidencePath = relative(evidenceRoot, evidence);
if (!localEvidencePath || localEvidencePath.startsWith("..") || localEvidencePath.includes(":")) throw new Error("thinking_real_evidence_outside_local_scope");
const phaseName = name => resume ? name.replace(/(\.[^.]+)$/u, `-${id}$1`) : name;
const data = join(evidence, "data");
const compiledDist = reuseArgument ? relative(root, resolve(root, reuseArgument.slice("--reuse-build=".length))).replaceAll("\\", "/") : "output/reflection-thinking-p1/isolated-source-2026-11-02T08-57-16-761Z/tmp/reflection-thinking-p1-build-2026-11-02T08-57-25-921Z";
if (compiledDist.startsWith("..") || compiledDist.includes(":")) throw new Error("thinking_real_build_outside_workspace");
const dist = development ? `tmp/reflection-thinking-real-${id}` : compiledDist;
const manifestPath = resolve(root, compiledDist, "../..", "SOURCE_MANIFEST.json");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const credentials = { ...parseEnv(await readFile(resolve(root, ".env.local"), "utf8")), ...process.env };
let configured;
try { configured = new URL(credentials.OPENAI_BASE_URL); } catch { throw new Error("thinking_real_endpoint_missing"); }
if (!credentials.OPENAI_API_KEY?.trim() || !["http:", "https:"].includes(configured.protocol)
  || configured.hostname !== "tokenhub.vision-intelligence.tech" || configured.username || configured.password
  || configured.port || configured.search || configured.hash || !["/", "/v1", "/v1/"].includes(configured.pathname))
  throw new Error("thinking_real_existing_configuration_not_usable");
await mkdir(data, { recursive: true });
const authorization = resume ? JSON.parse(await readFile(join(evidence, "AUTHORIZATION.json"), "utf8")) : { mode: "real", model: "deepseek-v4-pro", maxRequests: 12,
  endpoint: "https://tokenhub.vision-intelligence.tech/v1/responses", haltOnUnknown: true, hiddenRetries: 0,
  accountScope: "new local synthetic account only", environment: "loopback local application; no production access", createdAt: new Date().toISOString() };
if (p3 && !resume) { authorization.phase = "P3"; authorization.captureSyntheticInput = true; }
if (authorization.mode !== "real" || authorization.model !== "deepseek-v4-pro" || authorization.maxRequests !== 12) throw new Error("thinking_real_authorization_invalid");
if (!resume) await writeFile(join(evidence, "AUTHORIZATION.json"), JSON.stringify(authorization, null, 2), { flag: "wx" });
let sentBefore = 0;
if (resume) {
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const network = new Database(join(evidence, "network-ledger.sqlite"), { readonly: true, fileMustExist: true });
  try {
    const batch = network.prepare("SELECT halted FROM guard_state WHERE id=1").get();
    sentBefore = network.prepare("SELECT COUNT(*) AS count FROM requests").get().count;
    if (batch?.halted || network.prepare("SELECT 1 FROM requests WHERE state<>'completed' LIMIT 1").get() || sentBefore >= 12)
      throw new Error("thinking_real_resume_forbidden_unknown_or_budget");
  } finally { network.close(); }
  const business = new Database(join(data, "daily-reflection.sqlite"), { readonly: true, fileMustExist: true });
  try { if (business.prepare("SELECT 1 FROM agent_calls WHERE status IN ('running','unknown') LIMIT 1").get()) throw new Error("thinking_real_resume_forbidden_shared_unknown"); }
  finally { business.close(); }
  if (existsSync(join(evidence, "STOP_SERVER"))) {
    const { rename } = await import("node:fs/promises");
    await rename(join(evidence, "STOP_SERVER"), join(evidence, `STOP_SERVER-${id}.record`));
  }
}
const baseline = { workspace: root,
  branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8", windowsHide: true }).trim(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
  status: execFileSync("git", ["status", "--short"], { encoding: "utf8", windowsHide: true }),
  preconditions: { credentialPresent: true, configuredProtocol: configured.protocol, configuredHost: configured.hostname,
    actualEndpoint: authorization.endpoint, authHeaderMode: credentials.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw" ? "raw" : "bearer" },
};
await writeFile(join(evidence, phaseName("baseline.json")), JSON.stringify(baseline, null, 2));
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const production = manifest.files.filter(entry => /^(?:src\/|public\/|package(?:-lock)?\.json$|next\.config\.mjs$)/u.test(entry.path) && !/\.test\./u.test(entry.path));
const currentProduction = [];
for (const entry of production) {
  const currentSha256 = digest(await readFile(resolve(root, entry.path)));
  if (currentSha256 !== entry.sha256 && (!development || entry.path !== "src/lib/server/daily-reflection/thinking-agent.ts"))
    throw new Error(`thinking_real_build_source_changed:${entry.path}`);
  currentProduction.push({ ...entry, currentSha256 });
}
await writeFile(join(evidence, phaseName("source-provenance.json")), JSON.stringify({ mode: development ? "development_current_source" : "production_matching_build",
  manifestPath, dist, verifiedProductionFiles: production.length, production: currentProduction }, null, 2));
const nextEnvPath = resolve(root, "next-env.d.ts"), nextEnv = await readFile(nextEnvPath);
let tsconfig = "tsconfig.json";
if (development) {
  const configPath = join(evidence, phaseName("dev-tsconfig.json"));
  await writeFile(configPath, JSON.stringify({ extends: "../../../tsconfig.json", compilerOptions: { baseUrl: "../../..", paths: { "@/*": ["./src/*"] } },
    include: [resolve(root, "src/**/*.ts"), resolve(root, "src/**/*.tsx"), nextEnvPath, resolve(root, dist, "types/**/*.ts")] }, null, 2));
  tsconfig = relative(root, configPath).replaceAll("\\", "/");
}
const port = await new Promise((resolvePort, reject) => { const listener = createServer(); listener.on("error", reject);
  listener.listen(0, "127.0.0.1", () => { const port = listener.address().port; listener.close(() => resolvePort(port)); }); });
const env = { ...process.env,
  NEXT_TELEMETRY_DISABLED: "1", NEXT_WEBPACK_PARALLELISM: "2", APP_DATA_DIR: data, DATA_DIR: data,
  APP_STORAGE_MODE: "local", PIPELINE_EXECUTION_MODE: "inline", REDIS_URL: "",
  DAILY_BRIEF_E2E_DIST_DIR: dist, DAILY_BRIEF_E2E_TSCONFIG: tsconfig,
  DAILY_BRIEF_INVITE_CODES: "thinking-p1-real-local", DAILY_REFLECTION_UPLOAD_ENABLED: "true",
  DAILY_REFLECTION_AI_REVIEW_MODE: "off", DAILY_REFLECTION_BROWSER_RECORDING_ENABLED: "false",
  DAILY_BRIEF_TOY_SYNC_ENABLED: "false", DAILY_REFLECTION_TOY_SYNC_ENABLED: "false",
  WORK_REVIEW_ENABLED: "false", LEARNING_ENABLED: "false", LEARNING_AI_PROVIDER: "",
  TRANSCRIPTION_PROVIDER: "none", TRANSCRIPTION_FALLBACK_PROVIDER: "none",
  EXTRACTION_PROVIDER: "rule", AUDIO_INSIGHT_PROVIDER: "rule", RELATIONSHIP_SIGNAL_PROVIDER: "none",
  EMOTION_SIGNAL_PROVIDER: "none", PROACTIVE_INSIGHT_PROVIDER: "none", MEMORY_RELEVANCE_PROVIDER: "none",
  DATE_COMPANION_MEMORY_BRIDGE_ENABLED: "false", DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "false",
  QA_HYBRID_RETRIEVAL_MODE: "off", LLM_PROVIDER: "", QA_PROVIDER: "", VOICE_QA_LLM_PROVIDER: "",
  LANGCHAIN_TRACING: "false", LANGCHAIN_TRACING_V2: "false", LANGSMITH_TRACING: "false", LANGSMITH_TRACING_V2: "false",
  OPENAI_API_KEY: credentials.OPENAI_API_KEY, OPENAI_BASE_URL: credentials.OPENAI_BASE_URL,
  OPENAI_AUTH_HEADER_MODE: credentials.OPENAI_AUTH_HEADER_MODE?.trim().toLowerCase() === "raw" ? "raw" : "bearer",
  THINKING_P1_REAL_DIR: evidence,
  ...(p3 ? { THINKING_REAL_CAPTURE_SYNTHETIC_INPUT: "1" } : {}),
  NODE_OPTIONS: `--max-old-space-size=4096 --require=${resolve(root, "scripts/reflection-thinking-real-network-guard.cjs").replaceAll("\\", "/")}`,
};
for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|SECRET|BASE_URL|REDIS_URL)$/u.test(key)
  && !["OPENAI_API_KEY", "OPENAI_BASE_URL"].includes(key)) env[key] = "";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", development ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)],
  { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const capture = chunk => {
  // The product logging is already body-free; redact credentials defensively.
  let text = chunk.toString();
  if (env.OPENAI_API_KEY) text = text.replaceAll(env.OPENAI_API_KEY, "[REDACTED]");
  appendFileSync(join(evidence, phaseName("server.log")), text); process.stdout.write(text);
};
server.stdout.on("data", capture); server.stderr.on("data", capture);
const baseURL = `http://127.0.0.1:${port}`;
const infoPath = join(evidence, phaseName("server-info.json"));
await writeFile(infoPath, JSON.stringify({ evidence, data, baseURL, port, pid: server.pid, mode: development ? "development" : "production",
  sentBefore, providerBudget: 12, model: authorization.model, nextEnvBefore: digest(nextEnv) }, null, 2));
await writeFile(join(evidence, "CURRENT_SERVER.json"), JSON.stringify({ infoPath, at: new Date().toISOString() }));
console.log(`[thinking-real] ${sentBefore}/12 Provider requests; local server pid=${server.pid} evidence=${evidence}`);
const exitPromise = new Promise(resolveExit => { server.once("exit", (code, signal) => resolveExit({ code, signal })); });
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; server.kill(); } };
const timer = setInterval(() => { if (existsSync(join(evidence, "STOP_SERVER"))) stop(); }, 250);
timer.unref();
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try {
  let ready = false;
  for (let index = 0; index < 60; index += 1) {
    if (server.exitCode !== null) break;
    try { const response = await fetch(baseURL); if (response.status < 500) { ready = true; break; } } catch { /* Startup only, loopback. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  }
  if (!ready) { stop(); throw new Error("thinking_real_loopback_server_not_ready"); }
  const guardProof = JSON.parse(await readFile(join(evidence, `guard-ready-${server.pid}.json`), "utf8"));
  if (guardProof.pid !== server.pid || guardProof.maxRequests !== 12 || guardProof.model !== authorization.model
    || guardProof.authorizationSha256 !== digest(await readFile(join(evidence, "AUTHORIZATION.json")))) {
    stop(); throw new Error("thinking_real_guard_startup_proof_invalid");
  }
  await writeFile(join(evidence, phaseName("READY.json")), JSON.stringify({ baseURL, pid: server.pid, at: new Date().toISOString() }));
  console.log(`[thinking-real] ready ${baseURL}; no Provider preflight request sent`);
  const result = await exitPromise;
  await writeFile(join(evidence, phaseName("server-exit.json")), JSON.stringify({ ...result, requestedStop: stopping, at: new Date().toISOString() }, null, 2));
} finally {
  clearInterval(timer); if (server.exitCode === null) stop();
  await writeFile(nextEnvPath, nextEnv);
  await writeFile(join(evidence, phaseName("next-env-proof.json")), JSON.stringify({ before: digest(nextEnv), after: digest(await readFile(nextEnvPath)), preserved: digest(nextEnv) === digest(await readFile(nextEnvPath)) }, null, 2));
  console.log(`[thinking-real] local server stopped; evidence=${relative(root, evidence)}`);
}
