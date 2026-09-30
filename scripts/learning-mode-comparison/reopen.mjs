// Read saved real results after a normal app restart. No generation or answer mutation.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { chromium, expect as check } from '@playwright/test';
import { root, base, save, vault } from './runtime.mjs';
const secure = vault('read'), count = () => fs.readdirSync(root).filter(f => /^ds-request-\d+\.json$/.test(f)).length;
const before = count(), results = [], expect = check.configure({ timeout: 90000 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, serviceWorkers: 'block' });
const tab = await context.newPage(), errors = [];
tab.on('pageerror', e => errors.push(e.message));
await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
const login = async () => assert.equal((await context.request.post(base + '/api/auth/login', { data: { email: secure.email, password: secure.password } })).status(), 200);
try {
  await login();
  for (const [label, file] of [['practice', 'practice-open-A2-result.json'], ['test', 'test-complete-D3-result.json']]) {
    const saved = JSON.parse(fs.readFileSync(root + '/' + file)), pageId = new URL(saved.url).pathname.split('/').at(-1);
    const read = async () => {
      // Production cookies stay Secure. Chromium treats loopback as trustworthy;
      // Playwright's separate HTTP client does not send Secure cookies over HTTP.
      const response = await tab.evaluate(async url => {
        const r = await fetch(url, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() };
      }, '/api/learning/pages/' + pageId + '/quiz?attempt=' + saved.attempt.id);
      assert.equal(response.status, 200); return response.body.attempt;
    };
    await tab.goto(saved.url);
    const region = tab.getByRole('region', { name: '单选 Quiz', exact: true });
    await expect(region).toBeVisible();
    if (label === 'test') await expect(region.getByLabel('本次结果', { exact: true })).toBeVisible();
    else await expect(region.getByRole('article', { name: '当前作答' })).toBeVisible();
    assert.deepEqual(await read(), saved.attempt, 'Persisted answers, mode, option order and feedback must be identical');
    assert.equal(await tab.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status), 200);
    await context.clearCookies(); await login(); await tab.goto(saved.url);
    await expect(region).toBeVisible(); assert.deepEqual(await read(), saved.attempt);
    await tab.screenshot({ path: root + '/screenshots/production-reopen-' + label + '.png', fullPage: true });
    results.push({ label, attemptId: saved.attempt.id, completed: saved.attempt.completed, unchanged: true });
  }
  assert.equal(count(), before); assert.deepEqual(errors, []);
  save('production-reopen-result.json', { status: 'PASS', dsBefore: before, dsAfter: count(), results, errors });
  console.log(JSON.stringify({ status: 'PASS', reopened: results.length, ds: count() }));
} catch (error) {
  const message = String(error.message).split('Call log:')[0];
  save('production-reopen-failure-' + Date.now() + '.json', { message });
  console.error(message); process.exitCode = 1;
} finally {
  await browser.close(); save('production-reopen-exit.json', { exitCode: process.exitCode ?? 0, browserClosed: true });
}
