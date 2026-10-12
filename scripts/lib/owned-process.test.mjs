import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnOwned, stopOwned, completion } from './owned-process.mjs';
test('unowned processes cannot be stopped', async () => {
  await assert.rejects(stopOwned({ pid: process.pid }), /unowned/);
});
test('spawn failure is reported and cleanup is safe', async () => {
  const child = spawnOwned('daily-brief-deliberately-nonexistent-command', [], { stdio: 'ignore' });
  await assert.rejects(completion(child)); await stopOwned(child);
});
test('normal exit can be cleaned up repeatedly', async () => {
  const child = spawnOwned(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await completion(child); await stopOwned(child); await stopOwned(child);
});
test('stops only owned process tree, releases descendant port, preserves unrelated child', { timeout: 20000 }, async () => {
  const grandchildCode = `require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(this.address().port)});`;
  const parentCode = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);`;
  const other = spawnOwned(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const child = spawnOwned(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('descendant startup timeout')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.once('data', b => { clearTimeout(timer); resolve(Number(String(b).trim())); });
    });
    assert.ok(port > 0);
    await stopOwned(child, 100);
    let released = false;
    for (let i = 0; i < 30 && !released; i++) {
      released = await new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
      if (!released) await delay(50);
    }
    assert.equal(released, true); assert.equal(other.exitCode, null); assert.equal(other.signalCode, null);
  } finally { await stopOwned(child, 100); await stopOwned(other, 100); }
});
