import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

/** Prefer an explicit executable, then Playwright's installed browser. Known
 * local system paths are fallback discovery, never a browser download. */
export function chromiumLaunchOptions(env = process.env, platform = process.platform) {
  const explicit = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit && !fs.existsSync(explicit)) throw Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist');
  let executablePath = explicit;
  if (!executablePath && !fs.existsSync(chromium.executablePath())) {
    const candidates = platform === 'win32' ? [env.PROGRAMFILES, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(directory => [
      path.join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]) : platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    executablePath = candidates.find(candidate => fs.existsSync(candidate));
  }
  return { headless: true, ...(executablePath ? { executablePath } : {}), ...(platform === 'linux' ? { args: ['--no-sandbox'] } : {}) };
}
