// Build the exact current source in a small local validation snapshot. This avoids
// compile-time asset globbing through unrelated historical output and user data.
// No Git checkout, cleaning, file deletion or .env copying occurs.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = process.cwd(), id = new Date().toISOString().replace(/[:.]/g, "-");
const p2 = process.argv.includes("--p2");
const p3 = process.argv.includes("--p3");
const snapshot = resolve(root, p3 ? "output/reflection-thinking-p3" : p2 ? "output/reflection-thinking-p2" : "output/reflection-thinking-p1", `isolated-source-${id}`);
const paths = ["src", "public", "scripts", "e2e", "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts", "playwright.config.ts", "vitest.config.ts"];
const files = [];
async function collect(path) {
  const entries = await readdir(resolve(root, path), { withFileTypes: true }).catch(error => { if (error.code === "ENOTDIR") return null; throw error; });
  if (!entries) { files.push(path); return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Source snapshot does not follow symbolic links");
    const target = join(path, entry.name);
    if (entry.isDirectory()) await collect(target); else files.push(target);
  }
}
for (const path of paths) await collect(path);
await mkdir(snapshot, { recursive: true });
const hash = value => createHash("sha256").update(value).digest("hex");
const manifest = [];
console.log(`[thinking-p1-snapshot] 0/${files.length} preparing exact source snapshot`);
for (const [index, file] of files.entries()) {
  const target = resolve(snapshot, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, file), target);
  const sourceHash = hash(await readFile(resolve(root, file))), targetHash = hash(await readFile(target));
  if (sourceHash !== targetHash) throw new Error("Source copy changed during validation");
  manifest.push({ path: file.replaceAll("\\", "/"), sha256: sourceHash });
  if ((index + 1) % 100 === 0 || index + 1 === files.length) console.log(`[thinking-p1-snapshot] ${index + 1}/${files.length} copied and hash verified`);
}
await symlink(resolve(root, "node_modules"), resolve(snapshot, "node_modules"), "junction");
await writeFile(join(snapshot, "SOURCE_MANIFEST.json"), JSON.stringify({ sourceRoot: root, snapshot, files: manifest }, null, 2));
console.log(`[thinking-p1-snapshot] ${files.length}/${files.length} running isolated production build and browser`);
const child = spawn(process.execPath, [resolve(snapshot, "scripts/run-reflection-thinking-p1-e2e.mjs"), ...(p3 ? ["--p3"] : p2 ? ["--p2"] : [])], { cwd: snapshot,
  env: { ...process.env, THINKING_P1_HEAP_MB: process.env.THINKING_P1_HEAP_MB || "3072" }, windowsHide: true, stdio: "inherit" });
const exitCode = await new Promise((resolveExit, reject) => { child.on("error", reject); child.on("exit", code => resolveExit(code ?? 1)); });
const changed = [];
for (const entry of manifest) if (hash(await readFile(resolve(root, entry.path))) !== entry.sha256) changed.push(entry.path);
await writeFile(join(snapshot, "RESULT.json"), JSON.stringify({ exitCode, sourceFiles: files.length, sourceUnchanged: changed.length === 0, changed, snapshot }, null, 2));
console.log(`[thinking-p1-snapshot] result=${exitCode} sourceUnchanged=${changed.length === 0} snapshot=${snapshot}`);
process.exitCode = exitCode || (changed.length ? 1 : 0);
