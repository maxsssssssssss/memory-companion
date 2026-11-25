const { spawnSync } = require('node:child_process');
const { accessSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const suites = [
  'src/lib/server/date-companion/preparation-agent.test.ts',
  'src/lib/server/date-companion/preparation-sources.test.ts',
  'src/lib/server/date-companion/preparation-review.test.ts',
  'src/app/api/date-companion/preparations/routes.test.ts',
  'src/lib/client/date-companion-notebook.test.ts',
  'src/components/date-companion/companion-preparation-book.test.tsx',
  'src/components/date-companion/prepare-preview/prepare-preview.test.tsx',
];

// Vitest treats paths as filters. Fail if a required suite was moved or removed.
for (const suite of suites) accessSync(path.join(root, suite));

const run = spawnSync(process.execPath, [
  '--require', './scripts/cloud/offline.cjs', 'node_modules/vitest/vitest.mjs',
  'run', '--maxWorkers=2', ...suites,
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
