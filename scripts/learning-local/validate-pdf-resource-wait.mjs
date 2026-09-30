// Local Next/API/SQLite/browser validation with explicit synthetic PDF responses.
// No real OCR/ASR/model request; does not start/stop the user's app or a tunnel.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chromium, expect as baseExpect } from '@playwright/test';
import { syntheticLearningPdf } from '../fixtures/learning-pdf.mjs';
const expect = baseExpect.configure({ timeout: 45000 }), repo = process.cwd(), root = path.resolve('output/playwright/learning-pdf-resource-wait-' + Date.now());
const slash = value => value.replaceAll('\\', '/');
fs.mkdirSync(root, { recursive: true });
const before = fs.readFileSync('next-env.d.ts');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const record = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2));
const control = mode => record('mock-control.json', { mode });
const ledger = () => fs.existsSync(root + '/pdf-mock-calls.jsonl') ? fs.readFileSync(root + '/pdf-mock-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const posts = materialId => ledger().filter(row => row.kind === 'post' && (!materialId || row.materialId === materialId));
record('findings.json', []); control('resource-wait');
record('tsconfig.json', { extends: slash(repo + '/tsconfig.json'), compilerOptions: { incremental: false, baseUrl: slash(repo), paths: { '@/*': ['./src/*'] } }, include: [slash(repo + '/src/**/*.ts'), slash(repo + '/src/**/*.tsx')], exclude: [slash(repo + '/node_modules')] });
const env = {};
for (const [key, value] of Object.entries(process.env)) if (/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath)$/i.test(key)) env[key] = value;
Object.assign(env, { APP_DATA_DIR: root + '/data', DATA_DIR: root + '/data', APP_STORAGE_MODE: 'local', PIPELINE_EXECUTION_MODE: 'inline', DAILY_BRIEF_INVITE_CODES: 'synthetic-resource-only',
  DAILY_REFLECTION_UPLOAD_ENABLED: 'false', WORK_REVIEW_ENABLED: 'false', NEXT_TELEMETRY_DISABLED: '1',
  DAILY_BRIEF_E2E_DIST_DIR: slash(path.relative(repo, root + '/next')), DAILY_BRIEF_E2E_TSCONFIG: slash(path.relative(repo, root + '/tsconfig.json')),
  LEARNING_AI_PROVIDER: 'tokenhub', LEARNING_AI_MODEL: 'deepseek-v4-pro', OPENAI_API_KEY: 'SYNTHETIC_NO_REAL_KEY', OPENAI_BASE_URL: 'https://synthetic.invalid/v1',
  LEARNING_PDF_SERVICE_URL: 'https://ocr.synthetic.invalid/internal/ocr/', LEARNING_PDF_SERVICE_TOKEN: 'SYNTHETIC_ONLY',
  LEARNING_PDF_KNOWN_FINDINGS_FILE: root + '/findings.json', LEARNING_PDF_RESOURCE_MOCK_OUTPUT: root,
  NODE_OPTIONS: `--max-old-space-size=8192 --require="${slash(repo + '/scripts/learning-local/pdf-resource-browser-mock.cjs')}"` });
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '-p', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => fs.appendFileSync(root + '/next.log', chunk));
let browser, code = 0; const checks = [], errors = [], identities = [];
const pass = text => { checks.push(text); console.log(`${checks.length}/9 ${text}`); };
try {
  console.log('0/9 starting isolated HTTPS-prefix PDF browser validation');
  const deadline = Date.now() + 180000; let ready = false;
  while (Date.now() < deadline) { assert(child.exitCode === null); try { ready = (await fetch(base + '/api/auth/me', { signal: AbortSignal.timeout(2000) })).status === 401; if (ready) break; } catch {} await new Promise(resolve => setTimeout(resolve, 300)); }
  assert(ready, 'Isolated app did not become ready');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' }), page = await context.newPage();
  page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(180000); page.on('pageerror', error => errors.push(error.message));
  const email = 'resource-' + randomUUID() + '@synthetic.invalid', password = 'SYNTHETIC-only-pass-123';
  assert.equal((await context.request.post(base + '/api/auth/register', { data: { email, password, inviteCode: 'synthetic-resource-only' } })).status(), 201);
  const read = async url => { const response = await context.request.get(base + url); assert(response.ok(), await response.text()); return response.json(); };
  const dialog = () => page.getByRole('dialog', { name: '材料与进度', exact: true });
  const reopen = async () => { if (!await dialog().isVisible()) await page.getByRole('button', { name: /^材料进度/ }).click(); await expect(dialog()).toBeVisible(); };
  const run = async id => (await read(`/api/learning/pages/${id}/preparation`)).runs.at(-1);
  const snapshot = async (name, id, materialId) => record(name + '.json', { run: await run(id), parsed: await read(`/api/learning/pages/${id}/materials/${materialId}/parsed?summary=1`), posts: posts(materialId) });
  const upload = async mode => {
    control(mode); const id = randomUUID(); assert.equal((await context.request.post(base + '/api/learning/pages', { data: { id, title: '[合成测试] ' + mode } })).status(), 200);
    await page.goto(`${base}/learning/${id}?view=materials`, { waitUntil: 'domcontentloaded' });
    // This resource-scheduling fixture uses only supported, unrotated originals.
    // Remove the general fixture's optional page-2 transform with equal-length
    // spaces; PDF object offsets/xref and all synthetic content stay intact.
    const transformed = syntheticLearningPdf({ pages: 3 }), transform = '/Rotate 90 /CropBox [10 20 590 780]';
    const source = transformed.toString('latin1'); assert.equal(source.split(transform).length, 2);
    const bytes = Buffer.from(source.replace(transform, ' '.repeat(transform.length)), 'latin1');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await page.getByLabel('添加文件', { exact: true }).setInputFiles({ name: '[合成测试] 三页课件.pdf', mimeType: 'application/pdf', buffer: bytes });
    await expect(dialog()).toBeVisible();
    await dialog().locator('summary').filter({ hasText: '其他整理方式' }).click(); await dialog().getByLabel('完成后', { exact: true }).selectOption('prepare');
    const beforeCalls = posts().length;
    await dialog().getByRole('button', { name: '准备材料 · 1 份', exact: true }).click();
    await expect.poll(async () => (await read(`/api/learning/pages/${id}`)).page.materials.length).toBe(1);
    const material = (await read(`/api/learning/pages/${id}`)).page.materials[0];
    identities.push({ id, materialId: material.id, sha256, mode, beforeCalls }); record('identities.json', identities);
    return { id, materialId: material.id, sha256 };
  };
  const first = await upload('resource-wait');
  await expect(dialog().getByText('等待解析资源 · 已完成 1/3 页', { exact: true })).toBeVisible();
  assert.equal(posts(first.materialId).length, 2); assert(posts(first.materialId).every(row => row.sha256 === first.sha256));
  await snapshot('resource-wait-before', first.id, first.materialId); await page.screenshot({ path: root + '/resource-wait-desktop.png', fullPage: true });
  pass('one page completed, second explicitly not accepted; saved resource-wait status and source identity visible');
  const count = posts(first.materialId).length;
  await page.keyboard.press('Escape'); await expect(dialog()).toBeHidden(); await reopen();
  await page.reload({ waitUntil: 'domcontentloaded' }); await reopen();
  await expect(dialog().getByText('等待解析资源 · 已完成 1/3 页', { exact: true })).toBeVisible();
  assert.equal(posts(first.materialId).length, count); pass('closing/reopening and refresh only read; no duplicate parse POST');
  await page.setViewportSize({ width: 390, height: 700 });
  await expect(dialog().getByText('等待解析资源 · 已完成 1/3 页', { exact: true })).toBeVisible();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert(await dialog().evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: root + '/resource-wait-mobile.png', fullPage: true }); pass('mobile waiting/progress state remains readable without horizontal overflow');
  control('ready');
  await expect.poll(async () => (await run(first.id))?.status, { timeout: 75000 }).toBe('completed');
  const firstCalls = posts(first.materialId); assert.deepEqual(firstCalls.map(row => row.page), [1, 2, 2, 3]); assert.equal(firstCalls[1].requestId, firstCalls[2].requestId);
  await snapshot('resource-resumed', first.id, first.materialId); await expect(dialog().getByText('材料已准备，可以开始练习', { exact: true })).toBeVisible();
  pass('service-advertised wait resumes only remaining pages; first completed page is never resent');
  await page.setViewportSize({ width: 1280, height: 800 }); const second = await upload('known-failure');
  await expect.poll(async () => (await run(second.id))?.status).toBe('needs_attention'); await reopen();
  await expect(dialog().getByRole('button', { name: '继续处理', exact: true })).toBeEnabled();
  assert.deepEqual(posts(second.materialId).map(row => row.page), [1, 2]); await snapshot('known-failure', second.id, second.materialId);
  control('ready'); await dialog().getByRole('button', { name: '继续处理', exact: true }).click();
  await expect.poll(async () => (await run(second.id))?.status, { timeout: 75000 }).toBe('completed');
  assert.deepEqual(posts(second.materialId).map(row => row.page), [1, 2, 2, 3]); await snapshot('explicit-resume', second.id, second.materialId);
  await expect(dialog().getByText('材料已准备，可以开始练习', { exact: true })).toBeVisible(); await page.screenshot({ path: root + '/explicit-resume-completed.png', fullPage: true });
  pass('main Continue control reuses prior completed page and publishes remaining pages through real local API/SQLite');
  const third = await upload('unknown');
  await expect.poll(async () => (await run(third.id))?.status).toBe('needs_attention');
  const unknownCount = posts(third.materialId).length; assert.deepEqual(posts(third.materialId).map(row => row.page), [1, 2]);
  await page.reload({ waitUntil: 'domcontentloaded' }); await reopen();
  await expect(dialog().getByText(/处理结果待确认，不会自动重新提交/).first()).toBeVisible();
  assert.equal(posts(third.materialId).length, unknownCount); pass('unknown outcome stays distinct from resource waiting; refresh never resubmits');
  const resumeButton = dialog().getByRole('button', { name: '继续处理', exact: true });
  if (await resumeButton.isEnabled()) { await resumeButton.click(); await expect.poll(async () => (await run(third.id))?.status).toBe('needs_attention'); }
  assert.equal(posts(third.materialId).length, unknownCount); await snapshot('unknown-preserved', third.id, third.materialId); await page.screenshot({ path: root + '/unknown-outcome-desktop.png', fullPage: true });
  pass('explicit unknown-outcome recovery does not silently create another parse request');
  await context.request.post(base + '/api/auth/logout'); assert.equal((await context.request.get(base + `/api/learning/pages/${first.id}`)).status(), 401);
  assert.equal((await context.request.post(base + '/api/auth/login', { data: { email, password } })).status(), 200);
  await page.goto(`${base}/learning/${first.id}?view=materials`, { waitUntil: 'domcontentloaded' }); await reopen(); await expect(dialog().getByText('材料已准备，可以开始练习', { exact: true })).toBeVisible();
  assert.equal(posts(first.materialId).length, 4); pass('relogin reads completed preparation with no duplicate processing');
  const calls = ledger();
  assert(calls.every(row => row.path.startsWith('/internal/ocr/')), 'Every OCR service call must preserve its configured prefix');
  for (const kind of ['health', 'post', 'lookup', 'cleanup']) assert(calls.some(row => row.kind === kind), 'Missing prefixed ' + kind + ' coverage');
  assert.deepEqual(errors, []); pass('authenticated health/parse/status/cleanup retain HTTPS prefix; no browser errors or real Provider requests');
} catch (error) { code = 1; record('failure.json', { message: error.message, stack: error.stack, errors }); console.error(checks.length + '/9 failed: ' + error.message); }
finally {
  await browser?.close();
  if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (fs.readFileSync('next-env.d.ts', 'utf8').includes('learning-pdf-resource-wait-')) fs.writeFileSync('next-env.d.ts', before);
  const open = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
  if (open) code = 1;
  // Keep screenshots, snapshots and call evidence; remove this run's synthetic
  // account/database only after its owned listener has stopped.
  const isolatedData = path.resolve(root, 'data');
  assert.equal(path.dirname(isolatedData), root);
  if (!open) fs.rmSync(isolatedData, { recursive: true, force: true });
  record('cleanup.json', { ownedListenerRemaining: open, isolatedDataRemoved: !fs.existsSync(isolatedData) });
  record('result.json', { code, port, checks, errors, ownedListenerRemaining: open, realProviders: 0, realOcr: 0, realAsr: 0, mockLedger: ledger(), evidence: 'Synthetic service responses; real isolated local API, SQLite and browser. Ten-minute wait expiry covered separately by unit tests.' });
  console.log(root); process.exitCode = code;
}
