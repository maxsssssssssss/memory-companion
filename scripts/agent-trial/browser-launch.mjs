import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

/** Prefer an explicit executable, then Playwright's installed browser. Known
 * local system paths are fallback discovery, never a browser download. */
export function chromiumLaunchOptions(env = process.env, platform = process.platform) {
  const explicit = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const isFile = filename => { try { return fs.statSync(filename).isFile(); } catch { return false; } };
  if (explicit && !isFile(explicit)) throw Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH must name an existing browser executable');
  let executablePath = explicit;
  if (!executablePath && !isFile(chromium.executablePath())) {
    const envValue = name => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const candidates = platform === 'win32' ? [envValue('ProgramFiles'), envValue('ProgramFiles(x86)'), envValue('LocalAppData')].filter(Boolean).flatMap(directory => [
      path.win32.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.win32.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]) : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    executablePath = candidates.find(candidate => isFile(candidate));
    if (!executablePath) throw Error('No installed Chromium/Chrome/Edge found; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to an existing local browser');
  }
  return { headless: true, ...(executablePath ? { executablePath } : {}), ...(platform === 'linux' ? { args: ['--no-sandbox'] } : {}) };
}
