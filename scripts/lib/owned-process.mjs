import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const owners = new WeakSet();
// POSIX groups are created here, so cleanup can never signal a caller's group.
export function spawnOwned(command, args, options = {}) {
  const child = spawn(command, args, { ...options, windowsHide: true, detached: process.platform !== 'win32' });
  owners.add(child);
  child.on('error', () => {}); // Callers observe completion even when spawn fails.
  return child;
}
export async function stopOwned(child, graceMs = 5000) {
  if (!owners.has(child)) throw Error('Refusing to stop an unowned process');
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (result.error) throw result.error;
  } else {
    const signalGroup = signal => {
      try { process.kill(-child.pid, signal); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    if (!signalGroup('SIGTERM')) return;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && signalGroup(0)) await delay(25);
    if (signalGroup(0)) signalGroup('SIGKILL');
  }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
  if (child.exitCode === null && child.signalCode === null) throw Error('Owned process did not exit');
}
export function completion(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`Command failed (exit=${code}, signal=${signal})`)));
  });
}
