// Run from a checkout containing both Git commits. Each run owns fresh SQLite pairs.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { join, relative, resolve } = require("node:path");
const { buildSync } = require("esbuild");
const Sqlite = require("better-sqlite3");

const repo = resolve(__dirname, "../..");
const oldCommit = "2b0a3d5685e3febc4b3b26025e3bfc5ad68eb634";
const reviewedCommit = "28fcc8afc46f19b33d5d85325607fa327d6e42f0";
const outputRoot = join(repo, "output/companion-pr3-withdrawal-fix/repro");
mkdirSync(outputRoot, { recursive: true });
const run = mkdtempSync(join(outputRoot, "run-"));
// The archived and current services run with synthetic storage and no provider
// credentials. The fixture's subject classifier is supplied in-process.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(path|systemroot|windir|comspec|pathext|temp|tmp|userprofile|localappdata)$/i.test(name)));
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const save = (file, value) => writeFileSync(join(run, file), JSON.stringify(value, null, 2) + "\n");
const makeDirectory = name => { const dir = join(run, name); mkdirSync(dir); return dir; };

function archive(ref) {
  const target = makeDirectory(ref.slice(0, 8));
  const tar = join(target, "source.tar");
  execFileSync("git", ["archive", "--format=tar", "--output", tar, ref, "src", "tsconfig.json"], { cwd: repo });
  execFileSync("tar", ["-xf", tar, "-C", target], { cwd: repo });
  return target;
}

function bundle(source, entry, name) {
  const outfile = join(run, name + ".cjs");
  const result = buildSync({ absWorkingDir: repo, entryPoints: [join(__dirname, entry + ".cjs")], outfile,
    platform: "node", target: "node22", format: "cjs", bundle: true, packages: "external",
    alias: { "@": join(source, "src") }, metafile: true, logLevel: "error" });
  const sourceHashes = {};
  for (const path of Object.keys(result.metafile.inputs)) {
    const file = resolve(repo, path);
    const root = file === join(__dirname, entry + ".cjs") ? repo : source;
    sourceHashes[relative(root, file).replaceAll("\\", "/")] = digest(file);
  }
  save(name + "-sources.json", sourceHashes);
  return outfile;
}

function invoke(bundlePath, dir, operation) {
  const stdout = execFileSync(process.execPath, ["--require", join(repo, "scripts/cloud/offline.cjs"), bundlePath, dir, operation], {
    cwd: dir, encoding: "utf8", env: { ...fixtureEnv, APP_STORAGE_MODE: "server", APP_DATA_DIR: dir }
  });
  appendFileSync(join(run, "calls.log"), [bundlePath, dir, operation].join(" ") + "\n" + stdout + "\n");
  return JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
}

function clonePair(dir, name) {
  const copy = makeDirectory(name);
  for (const filename of ["date-companion.sqlite", "memory.sqlite"]) {
    copyFileSync(join(dir, filename), join(copy, filename));
  }
  return copy;
}

function readback(dir) {
  const options = { readonly: true, fileMustExist: true };
  const date = new Sqlite(join(dir, "date-companion.sqlite"), options);
  const memory = new Sqlite(join(dir, "memory.sqlite"), options);
  const all = (db, sql) => db.prepare(sql).all();
  try {
    const versions = [date.prepare("SELECT MAX(version) FROM dc_schema_migrations").pluck().get(),
      memory.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()];
    return { versions,
      integrity: [date.pragma("integrity_check", { simple: true }), memory.pragma("integrity_check", { simple: true })],
      foreignKeys: [date.pragma("foreign_key_check"), memory.pragma("foreign_key_check")],
      interactions: all(date, "SELECT id,user_id,relationship_id,source_upload_id,status,source_state FROM dc_interactions"),
      mappings: all(date, "SELECT relationship_id,self_person_id,companion_person_id,version,status FROM dc_relationship_person_mappings"),
      outbox: all(date, "SELECT id,user_id,relationship_id,interaction_id,status,payload_digest FROM dc_memory_bridge_outbox"),
      evidence: all(memory, "SELECT * FROM person_evidence"),
      relationships: all(memory, "SELECT * FROM person_relationships ORDER BY id"),
      edges: all(memory, `SELECT e.*,r.type FROM person_relationship_evidence e
        JOIN person_relationships r ON e.account_id=r.account_id AND e.relationship_id=r.id ORDER BY e.id`),
      dateRelations: all(memory, "SELECT * FROM dc_person_relationship_links"),
      dateLinks: all(memory, "SELECT * FROM person_evidence_dc_links"),
      relationshipAudits: all(memory, "SELECT entity_id,evidence_id,action FROM person_admission_audits WHERE entity_type='relationship'"),
      bridgeReceipts: all(memory, "SELECT * FROM dc_memory_bridge_receipts"),
      observations: all(memory, "SELECT id,account_id,person_id,evidence_id,reason FROM person_subject_observations"),
      admissions: all(memory, "SELECT id,account_id,person_id,evidence_id,disposition FROM person_subject_admissions"),
      memoryItems: all(memory, "SELECT id,user_id,type,summary FROM memory_items"),
      memoryEvidence: all(memory, "SELECT id,memory_id,source_id,upload_id,quote FROM memory_evidence"),
      retainedUploads: all(memory, "SELECT * FROM dc_retained_uploads"),
      withdrawals: versions[0] >= 15 ? all(date, "SELECT * FROM dc_memory_withdrawn_grants") : [],
      tombstones: all(memory, "SELECT * FROM memory_upload_tombstones")
    };
  } finally {
    date.close();
    memory.close();
  }
}

const legacy = bundle(archive(oldCommit), "seed", "old");
const reviewed = bundle(archive(reviewedCommit), "withdraw", "reviewed");
const repaired = bundle(repo, "withdraw", "working-tree");
console.log("Reproduction evidence:", run);
save("versions.json", {
  oldCommit, reviewedCommit, checkout: execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim(),
  node: process.version, bundleSha256: { old: digest(legacy), reviewed: digest(reviewed), workingTree: digest(repaired) }
});
const comparisons = [];

for (const scenario of ["shared", "same-edge", "grant-only"]) {
  const old = makeDirectory(scenario + "-old");
  const seed = invoke(legacy, old, scenario);
  const original = readback(old);
  save(scenario + "-old.json", { seed, original });
  assert.deepEqual(original.versions, [13, 14]);
  assert.equal(original.evidence.length, 1);
  assert.equal(original.dateLinks.length, 1);
  assert.equal(original.dateLinks[0].person_evidence_id, original.evidence[0].id);
  const independentlyConfirmed = r => r.id === seed.independentRelationshipId;
  const independent = original.edges.filter(e => e.relationship_id === seed.independentRelationshipId);
  assert.equal(independent.length, scenario === "grant-only" ? 0 : 1);
  if (independent.length) assert.equal(independent[0].evidence_id, original.evidence[0].id);
  if (scenario === "same-edge") assert.equal(original.dateRelations[0].person_relationship_id, seed.independentRelationshipId);

  const existing = clonePair(old, scenario + "-existing-v15");
  invoke(reviewed, existing, "migrate");
  assert.deepEqual(readback(existing).versions, [15, 15]);
  if (scenario === "shared") {
    const pending = clonePair(old, "pending-receipt");
    const oldPreflight = invoke(legacy, pending, "inspect");
    assert.equal(oldPreflight.ok, true);
    const oldReceipt = invoke(legacy, pending, "fail-old-purge");
    const migration = invoke(repaired, pending, "migrate");
    const oldAfterUpgrade = invoke(legacy, pending, "inspect");
    assert.deepEqual(oldAfterUpgrade.errorCodes.toSorted(), ["date_companion_schema_incompatible", "memory_schema_incompatible"]);
    const readback = invoke(repaired, pending, "inspect-pending");
    save("pending-receipt.json", { oldPreflight, oldReceipt, migration, oldAfterUpgrade, readback });
  }
  if (scenario === "shared") {
    const dir = clonePair(existing, "interrupted-cleanup");
    invoke(repaired, dir, "migrate");
    const interrupted = invoke(repaired, dir, "interrupt-cleanup");
    const during = readback(dir);
    assert.deepEqual(during.edges, independent);
    assert.deepEqual(during.evidence, original.evidence);
    assert.equal(during.dateLinks.length, 0);
    assert.equal(during.memoryItems.length, 0);
    assert.equal(during.bridgeReceipts.length, 1);
    const resumed = invoke(repaired, dir, "resume-cleanup");
    const after = readback(dir);
    assert.deepEqual(after.edges, during.edges);
    assert.deepEqual(after.evidence, during.evidence);
    assert.equal(after.withdrawals[0].attempt_count, 2);
    assert.equal(after.bridgeReceipts.length, 0);
    assert.equal(resumed.receipt.purgeId, interrupted.receipt.purgeId);
    save("cleanup-retry.json", { interrupted, during, resumed, after });
  }
  for (const path of ["reviewed", "direct", "from-v15"]) {
    const binary = path === "reviewed" ? reviewed : repaired;
    const dir = clonePair(path === "from-v15" ? existing : old, scenario + "-" + path);
    const migration = invoke(binary, dir, "migrate");
    const before = readback(dir);
    invoke(binary, dir, "migrate");
    assert.deepEqual(readback(dir), before, "reopening/migrating changed the upgraded rows");
    const outcome = invoke(binary, dir, "withdraw");
    const after = readback(dir);
    save(scenario + "-" + path + ".json", { migration, before, ...outcome, after });
    assert.deepEqual(after.integrity, ["ok", "ok"]);
    assert.deepEqual(after.foreignKeys, [[], []]);
    assert.deepEqual(after.mappings, original.mappings);
    assert.deepEqual(after.interactions, original.interactions);
    assert.equal(after.withdrawals.length, 1);
    assert.equal(after.withdrawals[0].status, "completed");
    assert.equal(after.withdrawals[0].outbox_id, seed.worker.outboxId);
    assert.equal(after.withdrawals[0].attempt_count, 1);
    for (const field of ["dateLinks", "bridgeReceipts", "retainedUploads", "memoryItems",
      "memoryEvidence", "observations", "admissions", "outbox", "tombstones"]) {
      assert.equal(after[field].length, 0, field);
    }
    const keep = scenario !== "grant-only" && path !== "reviewed";
    assert.deepEqual(after.evidence, keep ? before.evidence : []);
    assert.deepEqual(after.edges, keep ? independent : []);
    assert.deepEqual(after.relationships.filter(independentlyConfirmed), original.relationships.filter(independentlyConfirmed));
    comparisons.push({
      scenario, path, from: path === "from-v15" ? [15, 15] : original.versions, to: before.versions,
      receipt: outcome.receipt.status, repeatedReceipt: outcome.replay.purgeId === outcome.receipt.purgeId,
      canonicalEvidence: [before.evidence.length, after.evidence.length],
      independentRelationshipEdges: [independent.length, after.edges.filter(e => e.relationship_id === seed.independentRelationshipId).length],
      dateLinks: [before.dateLinks.length, after.dateLinks.length],
      dateMemoryItems: [before.memoryItems.length, after.memoryItems.length],
      dateObservations: [before.observations.length, after.observations.length]
    });
    console.log(scenario, path, before.versions, outcome.receipt.status,
      "evidence", before.evidence.length, "->", after.evidence.length,
      "independent edges", independent.length, "->", after.edges.filter(e => e.relationship_id === seed.independentRelationshipId).length);
  }
}
save("summary.json", comparisons);
