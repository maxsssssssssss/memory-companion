import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

const root = process.cwd(), runId = new Date().toISOString().replace(/[:.]/g, "-");
const development = process.argv.includes("--dev");
const p2 = process.argv.includes("--p2");
const p3 = process.argv.includes("--p3");
const reuseArgument = process.argv.find(value => value.startsWith("--reuse-build="));
const reuseBuild = reuseArgument ? resolve(root, reuseArgument.slice("--reuse-build=".length)) : null;
const heapMb = Number(process.env.THINKING_P1_HEAP_MB ?? "8192");
if (!Number.isSafeInteger(heapMb) || heapMb < 1024 || heapMb > 8192) throw new Error("Invalid local validation heap limit");
const artifacts = resolve(root, p3 ? "output/reflection-thinking-p3" : p2 ? "output/reflection-thinking-p2" : "output/reflection-thinking-p1", runId), data = join(artifacts, "data");
await mkdir(data, { recursive: true });
const dist = reuseBuild ? relative(root, reuseBuild).replaceAll("\\", "/") : `tmp/reflection-thinking-p1-build-${runId}`;
const tsconfig = join(artifacts, "tsconfig.json");
await writeFile(tsconfig, JSON.stringify({ extends: "../../../tsconfig.json", compilerOptions: { baseUrl: "../../..", paths: { "@/*": ["./src/*"] } },
  include: [resolve(root, "src/**/*.ts"), resolve(root, "src/**/*.tsx"), resolve(root, "next-env.d.ts"), resolve(root, `${dist}/types/**/*.ts`)] }, null, 2));
const nextEnv = await readFile(resolve(root, "next-env.d.ts"));
const hash = value => createHash("sha256").update(value).digest("hex");
const port = await new Promise(resolvePort => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolvePort(port)); }); });
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", APP_DATA_DIR: data, APP_STORAGE_MODE: "local", PIPELINE_EXECUTION_MODE: "inline", REDIS_URL: "",
  NEXT_WEBPACK_PARALLELISM: "2",
  DAILY_BRIEF_INVITE_CODES: "thinking-p1-fixture", DAILY_REFLECTION_UPLOAD_ENABLED: "true",
  DAILY_BRIEF_E2E_DIST_DIR: dist, DAILY_BRIEF_E2E_TSCONFIG: relative(root, tsconfig).replaceAll("\\", "/"),
  OPENAI_BASE_URL: "https://tokenhub.vision-intelligence.tech/v1", OPENAI_API_KEY: "offline-thinking-synthetic-key", OPENAI_AUTH_HEADER_MODE: "raw",
  THINKING_P1_E2E_BASE_URL: `http://127.0.0.1:${port}`, THINKING_P1_E2E_ARTIFACT_DIR: artifacts,
  ...(p2 ? { THINKING_P2_E2E: "1" } : {}),
  ...(p3 ? { THINKING_P3_E2E: "1" } : {}),
  NODE_OPTIONS: `--max-old-space-size=${heapMb} --require=${resolve(root, "scripts/date-companion-e2e-network-guard.cjs").replaceAll("\\", "/")} --require=${resolve(root, "scripts/reflection-thinking-offline-fixture.cjs").replaceAll("\\", "/")}`,
  QA_HYBRID_RETRIEVAL_MODE: "off", MEMORY_RELEVANCE_PROVIDER: "none", DATE_COMPANION_MEMORY_BRIDGE_ENABLED: "false",
  DATE_COMPANION_MEMORY_BRIDGE_CONSUMER_ENABLED: "false", AUDIO_INSIGHT_PROVIDER: "rule", EXTRACTION_PROVIDER: "rule", RELATIONSHIP_SIGNAL_PROVIDER: "none", EMOTION_SIGNAL_PROVIDER: "none", PROACTIVE_INSIGHT_PROVIDER: "none",
};
for (const key of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN|SECRET|BASE_URL|REDIS_URL)$/u.test(key) && !["OPENAI_API_KEY", "OPENAI_BASE_URL", "THINKING_P1_E2E_BASE_URL"].includes(key)) env[key] = "";
let server;
let restartTimer, restartJob, restartBusy = false, shuttingDown = false;
const summary = { runId, artifacts, data, dist, mode: development ? "development" : "production", buildExit: null, browserExit: null, realProviderRequests: 0, nextEnvBefore: hash(nextEnv) };
const sourceFiles = ["package.json", "package-lock.json", "next.config.mjs", "src/lib/server/daily-reflection/thinking-agent.ts", "src/lib/server/daily-reflection/thinking-agent-service.ts",
  "src/lib/server/daily-reflection/thinking-matter-repository.ts", "src/lib/server/daily-reflection/schema.ts", "src/lib/domain/reflection-thinking-matter.ts",
  "src/components/daily-reflection/reflection-thinking-matters.tsx", "src/components/daily-reflection/reflection-thinking-workspace.tsx", "src/components/daily-reflection/daily-reflection.module.css",
  "src/lib/client/reflection-thinking-matters-api.ts", "src/app/api/daily-reflections/thinking/matters/route.ts", "src/app/api/daily-reflections/thinking/matters/[matterId]/route.ts",
  "src/lib/server/agent/runtime.ts", "src/lib/server/agent/store.ts", "src/lib/server/agent/model.ts", "src/lib/server/openai/structured-json.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(resolve(root, file)))])));
summary.sourceHashesBefore = await sourceHashes();
if (reuseBuild) {
  const manifestPath = resolve(reuseBuild, "../..", "SOURCE_MANIFEST.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const production = manifest.files.filter(entry => /^(?:src\/|public\/|package(?:-lock)?\.json$|next\.config\.mjs$)/u.test(entry.path) && !/\.test\./u.test(entry.path));
  for (const entry of production) if (hash(await readFile(resolve(root, entry.path))) !== entry.sha256) throw new Error("Reused production build source differs from current source");
  summary.reusedBuild = { dist: reuseBuild, manifestPath, verifiedProductionFiles: production.length };
}
function run(args, name, command = process.execPath) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, shell: command === "npm.cmd", stdio: ["ignore", "pipe", "pipe"] });
    const capture = chunk => { const text = chunk.toString(); process.stdout.write(text); import("node:fs").then(fs => fs.appendFileSync(join(artifacts, `${name}.log`), text)); };
    child.stdout.on("data", capture); child.stderr.on("data", capture); child.on("error", reject); child.on("exit", code => resolveExit(code ?? 1));
  });
}
try {
  console.log(`[thinking-p1-runner] 0/3 isolated offline build, API and browser artifacts=${artifacts}`);
  if (!development && !reuseBuild) {
    summary.buildExit = await run(["run", "build"], "build", process.platform === "win32" ? "npm.cmd" : "npm");
    if (summary.buildExit !== 0) throw new Error("Production build failed");
  }
  console.log(`[thinking-p1-runner] 1/3 ${development ? "development server selected; production build NOT RUN in this execution" : reuseBuild ? "reusing successful production build with matching production source hashes" : "production build passed"}; starting loopback server`);
  const fs = await import("node:fs");
  const capture = chunk => { process.stdout.write(chunk); fs.appendFileSync(join(artifacts, "server.log"), chunk); };
  const startServer = () => {
    server = spawn(process.execPath, ["node_modules/next/dist/bin/next", development ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", capture); server.stderr.on("data", capture);
  };
  startServer();
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await fetch(env.THINKING_P1_E2E_BASE_URL); ready = true; break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 500)); }
  }
  if (!ready) throw new Error("Loopback server did not start");
  if (p3) restartTimer = setInterval(() => {
    if (shuttingDown || restartBusy || !existsSync(join(artifacts, "RESTART_REQUEST"))) return;
    restartBusy = true;
    restartJob = (async () => {
    try {
      const previousPid = server.pid;
      const oldExit = new Promise(resolveExit => server.once("exit", resolveExit));
      server.kill(); await oldExit;
      if (shuttingDown) return;
      startServer();
      for (let attempt = 0; attempt < 60; attempt++) {
        if (shuttingDown) return;
        try {
          if ((await fetch(env.THINKING_P1_E2E_BASE_URL)).status < 500) {
            summary.localRestart = { previousPid, currentPid: server.pid, sameDataDirectory: data, ready: true };
            await writeFile(join(artifacts, "RESTART_READY.json"), JSON.stringify(summary.localRestart)); return;
          }
        } catch { /* Only the owned loopback server. */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
      }
      throw new Error("Owned local restart failed");
    } catch (error) { await writeFile(join(artifacts, "RESTART_FAILED.json"), JSON.stringify({ message: error.message })); }
    })();
  }, 100);
  console.log(p3 ? "[thinking-p1-runner] 2/3 running P3 compatibility/recovery browser checks, 0/3 scenarios complete" : p2 ? "[thinking-p1-runner] 2/3 running P2 browser acceptance, 0/4 scenarios complete" : "[thinking-p1-runner] 2/3 running A-E browser acceptance, 0/5 scenarios complete");
  summary.browserExit = await run(["node_modules/@playwright/test/cli.js", "test", p3 ? "e2e/reflection-thinking-p3.spec.ts" : p2 ? "e2e/reflection-thinking-p2.spec.ts" : "e2e/reflection-thinking-p1.spec.ts", "--workers=1", "--reporter=line", `--output=${join(artifacts, "playwright")}`], "browser");
  if (summary.browserExit !== 0) throw new Error("Browser acceptance failed");
  console.log("[thinking-p1-runner] 3/3 offline acceptance passed");
} catch (error) { summary.failure = error.message; process.exitCode = 1; }
finally {
  shuttingDown = true;
  clearInterval(restartTimer);
  await restartJob;
  if (server && server.exitCode === null && server.signalCode === null) {
    const finalExit = new Promise(resolveExit => server.once("exit", resolveExit)); server.kill(); await finalExit;
  }
  await writeFile(resolve(root, "next-env.d.ts"), nextEnv);
  summary.nextEnvAfter = hash(await readFile(resolve(root, "next-env.d.ts")));
  summary.sourceHashesAfter = await sourceHashes();
  summary.sourceStable = JSON.stringify(summary.sourceHashesBefore) === JSON.stringify(summary.sourceHashesAfter);
  await writeFile(join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[thinking-p1-runner] evidence=${artifacts}`);
}
