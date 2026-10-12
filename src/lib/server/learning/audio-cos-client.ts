import { createHash, createHmac } from "node:crypto";

/** Private, temporary Cloud synthetic audio only. No object listing or public ACL. */
export type CosConfig = { bucket: string; region: string; prefix: string; secretId: string; secretKey: string };
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function cosConfig(env: Partial<NodeJS.ProcessEnv>): CosConfig {
  const config = { bucket: env.DAILY_BRIEF_COS_BUCKET ?? "", region: env.DAILY_BRIEF_COS_REGION ?? "",
    prefix: env.DAILY_BRIEF_COS_PREFIX ?? "", secretId: env.DAILY_BRIEF_COS_SECRET_ID ?? "", secretKey: env.DAILY_BRIEF_COS_SECRET_KEY ?? "" };
  if (!/^[a-z0-9][a-z0-9-]+-\d+$/.test(config.bucket) || !/^ap-[a-z]+$/.test(config.region)
    || config.prefix !== "cloud-asr/" || !config.secretId || !config.secretKey
    || config.secretId.trim() !== config.secretId || config.secretKey.trim() !== config.secretKey) throw Error("cos_configuration_invalid");
  return config;
}
export const cosHost = (config: CosConfig) => `${config.bucket}.cos.${config.region}.myqcloud.com`;
function objectKey(config: CosConfig, key: string) {
  if (!key.startsWith(config.prefix) || !/^cloud-asr\/(?:codex-asr|learning)-[0-9a-f-]{36}\/chunk\.mp3$/.test(key)) throw Error("object_out_of_scope");
}
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const canonical = (values: Record<string, string>) => Object.entries(values).map(([k,v]) => [encode(k).toLowerCase(), encode(v)])
  .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => `${k}=${v}`).join("&");

/** COS v5 documented HMAC-SHA1 protocol. Golden vectors were cross-checked
 * against integrity-verified official cos-nodejs-sdk-v5 3.0.0, including host,
 * method and version query binding. No SDK transport, retries or new app deps. */
export function cosAuthorization(config: CosConfig, method: string, key: string,
  query: Record<string,string> = {}, headers: Record<string,string> = {},
  start = Math.floor(Date.now()/1000)-1, end = start + 180) {
  objectKey(config, key);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end-start > 300
    || !["GET","HEAD","PUT","DELETE"].includes(method)) throw Error("signature_scope_invalid");
  const signedHeaders = { ...Object.fromEntries(Object.entries(headers).map(([k,v]) => [k.toLowerCase(),v])), host: cosHost(config) };
  const keyTime = `${start};${end}`;
  const signingKey = createHmac("sha1", config.secretKey).update(keyTime).digest("hex");
  const request = `${method.toLowerCase()}\n/${key}\n${canonical(query)}\n${canonical(signedHeaders)}\n`;
  const toSign = `sha1\n${keyTime}\n${createHash("sha1").update(request).digest("hex")}\n`;
  return `q-sign-algorithm=sha1&q-ak=${config.secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}`
    + `&q-header-list=${Object.keys(signedHeaders).map(k=>encode(k).toLowerCase()).sort().join(";")}`
    + `&q-url-param-list=${Object.keys(query).map(k=>encode(k).toLowerCase()).sort().join(";")}`
    + `&q-signature=${createHmac("sha1",signingKey).update(toSign).digest("hex")}`;
}
export function cosUrl(config: CosConfig, key: string, query: Record<string,string> = {}, signature?: string) {
  objectKey(config,key); const url = new URL(`https://${cosHost(config)}/${key}`);
  for(const [k,v] of Object.entries(query)) url.searchParams.set(k,v);
  if(signature) for(const [k,v] of new URLSearchParams(signature)) url.searchParams.set(k,v);
  return url;
}
