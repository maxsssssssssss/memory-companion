// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { chromiumLaunchOptions } from "./browser-launch.mjs";
const require = createRequire(import.meta.url), Database = require("better-sqlite3");
const { assertEvidenceDirectory } = require("./evidence-directory.cjs");
const roots: string[] = [];
const temporary = () => { const root = fs.mkdtempSync(path.join(tmpdir(), "agent-script-contract-")); roots.push(root); return root; };
const child = (args: string[], root: string, extra: Record<string, string> = {}) => spawnSync(process.execPath, ["--require", path.resolve("scripts/cloud/offline.cjs"), ...args], {
  encoding: "utf8", timeout: 15000, env: { NODE_ENV: "test", PATH: process.env.PATH, AGENT_TRIAL_DIR: root, ...extra },
});
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("status and stop of an absent trial are read-only and do not invent an owned process", () => {
  const root = path.join(temporary(), "absent");
  for (const operation of ["status", "stop"]) {
    const result = child(["scripts/agent-trial/launch.mjs", operation], root);
    expect(result.status, result.stderr).toBe(0); expect(fs.existsSync(root)).toBe(false);
  }
});
it("status prints only process metadata and stopping a recorded completed trial changes nothing", () => {
  const root = temporary(), filename = path.join(root, "runtime.json");
  const body = JSON.stringify({ evidenceMode: "offline", stoppedAt: "2026-01-01T00:00:00Z", pid: 123, apiKey: "synthetic-do-not-print", arbitraryBody: "synthetic-private-body" });
  fs.writeFileSync(filename, body);
  const status = child(["scripts/agent-trial/launch.mjs", "status"], root);
  expect(status.status).toBe(0); expect(status.stdout).not.toContain("synthetic-"); expect(status.stdout).toContain('"pid": 123');
  expect(child(["scripts/agent-trial/launch.mjs", "stop"], root).status).toBe(0);
  expect(fs.readdirSync(root)).toEqual(["runtime.json"]); expect(fs.readFileSync(filename, "utf8")).toBe(body);
});
it.each(["offline", "real"])("%s ledger cannot change evidence tier by renaming its file and directory", mode => {
  const parent = temporary(), root = path.join(parent, "original"); fs.mkdirSync(root);
  const actualName = mode === "offline" ? "offline-provider.sqlite" : "network-ledger.sqlite";
  const pretendName = mode === "offline" ? "network-ledger.sqlite" : "offline-provider.sqlite";
  const db = new Database(path.join(root, actualName));
  db.exec(mode === "offline" ? "CREATE TABLE requests(id INTEGER,kind TEXT,actual_network_requests INTEGER)" : "CREATE TABLE requests(id INTEGER,phase TEXT,model TEXT,input_tokens INTEGER)"); db.close();
  fs.renameSync(path.join(root, actualName), path.join(root, pretendName));
  const renamed = path.join(parent, "renamed-to-pretend-mode"); fs.renameSync(root, renamed);
  const before = fs.readFileSync(path.join(renamed, pretendName));
  expect(() => assertEvidenceDirectory(renamed, mode === "offline" ? "real" : "offline")).toThrow("agent_trial_evidence_mode_conflict");
  expect(fs.readFileSync(path.join(renamed, pretendName))).toEqual(before);
});
it("discovers Windows browser paths case-insensitively without a download or Linux path joining", () => {
  const expected = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
  vi.spyOn(chromium, "executablePath").mockReturnValue("C:\\missing-playwright.exe");
  vi.spyOn(fs, "statSync").mockImplementation((name: fs.PathLike) => ({ isFile: () => String(name) === expected }) as fs.Stats);
  expect(chromiumLaunchOptions({ ProgramFiles: "C:\\Program Files" }, "win32")).toEqual({ headless: true, executablePath: expected });
});
it("browser discovery rejects a directory as an executable and reports missing local browsers clearly", () => {
  const folder = temporary();
  expect(() => chromiumLaunchOptions({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: folder }, "win32")).toThrow("existing browser executable");
  vi.spyOn(fs, "statSync").mockImplementation(() => { throw Error("synthetic_missing"); });
  expect(() => chromiumLaunchOptions({}, "win32")).toThrow("No installed Chromium/Chrome/Edge found");
});
it("the draft recheck only accepts B before/after restart and never creates trial data during argument validation", () => {
  const root = temporary();
  for (const phase of ["before-restart", "after-restart"]) {
    const accepted = child(["scripts/agent-trial/a2-browser.mjs", phase], root, { AGENT_TRIAL_SUBCASE: "draft", AGENT_TRIAL_CASES: "B" });
    expect(accepted.status).not.toBe(0); expect(accepted.stderr).toContain("ENOENT"); expect(accepted.stderr).toContain("runtime.json");
    expect(accepted.stderr).not.toContain("invalid_a2_subcase");
  }
  for (const [phase, cases, message] of [["faults", "B", "invalid_a2_subcase"], ["manual", "B", "invalid_a2_subcase"], ["before-restart", "A,B", "subcase_account_filter_conflict"]]) {
    const rejected = child(["scripts/agent-trial/a2-browser.mjs", phase], root, { AGENT_TRIAL_SUBCASE: "draft", AGENT_TRIAL_CASES: cases });
    expect(rejected.status).not.toBe(0); expect(rejected.stderr).toContain(message); expect(rejected.stderr).not.toContain("runtime.json");
  }
  expect(fs.readdirSync(root)).toEqual([]);
});

function initializeSeed(root: string, mode = "offline", args: string[] = []) {
  fs.writeFileSync(path.join(root, "runtime.json"), JSON.stringify({ evidenceMode: mode, base: "http://127.0.0.1:37951", dataRoot: path.join(root, "data"), inviteCode: "synthetic-only" }));
  const preload = path.join(root, "deny-api.cjs"); fs.writeFileSync(preload, "globalThis.fetch=async()=>{throw Error('synthetic_seed_api_blocked')};");
  return child(["--require", preload, "--import", "tsx", "scripts/agent-trial/seed.ts", ...args], root);
}
it.each([{ mode: "offline", args: [], keys: ["A", "B", "C", "D", "E", "F"] }, { mode: "real", args: ["--real"], keys: ["A", "B"] }, { mode: "offline", args: ["--manual"], keys: ["A", "B", "C", "D", "E", "F", "M"] }])("seed uses the explicit $mode account plan without reaching any API", ({ mode, args, keys }) => {
  const root = temporary(), result = initializeSeed(root, mode, args);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("synthetic_seed_api_blocked");
  const accounts = JSON.parse(fs.readFileSync(path.join(root, "synthetic-accounts.json"), "utf8"));
  expect(accounts.map((account: { key: string }) => account.key)).toEqual(keys);
});
it("completed seed reruns preserve every file and perform no API or database access", () => {
  const root = temporary(); initializeSeed(root);
  const frozen = JSON.parse(fs.readFileSync(path.join(root, "frozen-inputs.json"), "utf8"));
  const accounts = JSON.parse(fs.readFileSync(path.join(root, "synthetic-accounts.json"), "utf8"));
  for (const account of accounts) { account.userId = account.pageId; account.chapterId = account.frameworkId; account.nodeIds = [account.materialId]; }
  fs.writeFileSync(path.join(root, "synthetic-accounts.json"), JSON.stringify(accounts));
  fs.writeFileSync(path.join(root, "seed-result.json"), JSON.stringify({ status: "PASS", sourceSha256: frozen.sourceSha256, accounts }));
  const files = fs.readdirSync(root).filter(name => fs.statSync(path.join(root, name)).isFile());
  const original = new Map(files.map(name => [name, fs.readFileSync(path.join(root, name))]));
  const result = child(["--require", path.join(root, "deny-api.cjs"), "--import", "tsx", "scripts/agent-trial/seed.ts"], root);
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("no API/database writes");
  for (const name of files) expect(fs.readFileSync(path.join(root, name))).toEqual(original.get(name));
  expect(fs.existsSync(path.join(root, "data"))).toBe(false);
  fs.writeFileSync(path.join(root, "synthetic-course.txt"), "user-changed-synthetic-course-do-not-overwrite");
  const changed = child(["--require", path.join(root, "deny-api.cjs"), "--import", "tsx", "scripts/agent-trial/seed.ts"], root);
  expect(changed.status).not.toBe(0); expect(changed.stderr).toContain("frozen_material_file_changed");
  expect(fs.readFileSync(path.join(root, "synthetic-course.txt"), "utf8")).toBe("user-changed-synthetic-course-do-not-overwrite");
});
