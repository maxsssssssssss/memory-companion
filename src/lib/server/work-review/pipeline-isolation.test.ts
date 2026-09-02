// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { openWorkReviewDatabase } from "./db";

const repositoryRoot = resolve(process.cwd());
const productionRoots = [
  join(repositoryRoot, "src", "lib", "server", "work-review"),
  join(repositoryRoot, "src", "app", "api", "work-reviews")
];

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !/\.tsx?$/u.test(entry.name) || /\.test\.tsx?$/u.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function importSpecifiers(source: string) {
  return Array.from(source.matchAll(
    /(?:from\s+|import\s*)["']([^"']+)["']/gu
  ), (match) => match[1]!);
}

describe("Work Review pipeline isolation", () => {
  it("has no imports or calls into generic upload processing, Daily Reflection, Memory, Person, or hybrid retrieval", () => {
    const forbiddenImportFragments = [
      "/daily-reflection",
      "/memory",
      "/person",
      "/relationship",
      "/hybrid",
      "/queue/producer",
      "/pipeline-worker"
    ];
    const violations: string[] = [];

    for (const filePath of productionRoots.flatMap(sourceFiles)) {
      const source = readFileSync(filePath, "utf8");
      const localPath = relative(repositoryRoot, filePath).replaceAll("\\", "/");
      for (const specifier of importSpecifiers(source)) {
        if (forbiddenImportFragments.some((fragment) => specifier.includes(fragment))) {
          violations.push(`${localPath}: forbidden import ${specifier}`);
        }
      }
      if (/\bprocessUpload\s*\(/u.test(source)) {
        violations.push(`${localPath}: generic processUpload call`);
      }
      if (/\bDailyReflectionService\b|\bexecuteCandidateWorker\s*\(/u.test(source)) {
        violations.push(`${localPath}: Daily Reflection worker/service call`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("migrates only Work-owned application tables in the isolated SQLite database", () => {
    const database = openWorkReviewDatabase({ filePath: ":memory:" });
    try {
      const tableNames = (database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>).map((row) => row.name);

      expect(tableNames.length).toBeGreaterThan(0);
      expect(tableNames.every((name) => name.startsWith("wr_"))).toBe(true);
      expect(tableNames).not.toEqual(expect.arrayContaining([
        "uploads",
        "memories",
        "people",
        "relationships",
        "hybrid_documents",
        "todos"
      ]));
    } finally {
      database.close();
    }
  });
});
