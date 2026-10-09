import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { providerSecretAliases } from './providers.mjs';

export function providerLogRedactor(env) {
  const values = new Set();
  for (const key of [...Object.keys(providerSecretAliases), ...Object.values(providerSecretAliases),
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    const value = env[key];
    if (value) { values.add(value); values.add(value.trim()); }
    if (/proxy$/iu.test(key) && value) {
      try {
        const url = new URL(value);
        if (url.password) values.add(decodeURIComponent(url.password));
        if (url.username && url.password) values.add(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'));
      } catch { /* Never report proxy values. */ }
    }
  }
  const secrets = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  const overlap = Math.max(1, ...secrets.map(value => value.length)) - 1;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const replace = text => {
    const matches = [];
    for (const value of secrets) {
      let at = text.indexOf(value);
      while (at !== -1) { matches.push([at, at + value.length]); at = text.indexOf(value, at + 1); }
    }
    const ranges = [];
    for (const [start, end] of matches.sort((a, b) => a[0] - b[0])) {
      const last = ranges.at(-1);
      if (last && start <= last[1]) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }
    let output = '', cursor = 0;
    for (const [start, end] of ranges) { output += text.slice(cursor, start) + '[REDACTED]'; cursor = end; }
    return output + text.slice(cursor);
  };
  return new Transform({
    transform(chunk, encoding, callback) {
      pending += decoder.write(chunk);
      let end = Math.max(0, pending.length - overlap);
      // Keep a whole matching token when it straddles the emission boundary.
      let previous;
      do {
        previous = end;
        for (const value of secrets) {
          let at = pending.indexOf(value);
          while (at !== -1 && at < end) {
            if (at + value.length > end) end = at;
            at = pending.indexOf(value, at + 1);
          }
        }
      } while (previous !== end);
      if (end) { this.push(replace(pending.slice(0, end))); pending = pending.slice(end); }
      callback();
    },
    flush(callback) { this.push(replace(pending + decoder.end())); callback(); }
  });
}
