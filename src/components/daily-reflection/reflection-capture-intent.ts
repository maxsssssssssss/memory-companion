const VOICE_AUTOSTART_STORAGE_KEY = "daily-reflection:voice-autostart:v1";
const VOICE_AUTOSTART_MAX_AGE_MS = 15_000;
const CAPTURE_CONTEXT_STORAGE_KEY = "daily-reflection:capture-context:v1";
const CAPTURE_CONTEXT_MAX_AGE_MS = 5 * 60_000;

type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;

type VoiceAutostartIntent = Readonly<{
  issuedAt: number;
  version: 1;
}>;

type CaptureContextIntent = Readonly<{
  issuedAt: number;
  prompt: string;
  version: 1;
}>;

function currentSessionStorage(storage?: SessionStorageLike) {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function armVoiceAutostartIntent(
  storage?: SessionStorageLike,
  now: () => number = Date.now
) {
  const target = currentSessionStorage(storage);
  if (!target) return false;
  const intent: VoiceAutostartIntent = { issuedAt: now(), version: 1 };
  try {
    target.setItem(VOICE_AUTOSTART_STORAGE_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function consumeVoiceAutostartIntent(
  storage?: SessionStorageLike,
  now: () => number = Date.now
) {
  const target = currentSessionStorage(storage);
  if (!target) return false;
  let raw: string | null = null;
  try {
    raw = target.getItem(VOICE_AUTOSTART_STORAGE_KEY);
    target.removeItem(VOICE_AUTOSTART_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const value = JSON.parse(raw) as Partial<VoiceAutostartIntent>;
    if (value.version !== 1 || typeof value.issuedAt !== "number") return false;
    const age = now() - value.issuedAt;
    return age >= 0 && age <= VOICE_AUTOSTART_MAX_AGE_MS;
  } catch {
    return false;
  }
}

export function armCaptureContextIntent(
  prompt: string,
  storage?: SessionStorageLike,
  now: () => number = Date.now
) {
  const target = currentSessionStorage(storage);
  const normalizedPrompt = prompt.normalize("NFC").trim().slice(0, 240);
  if (!target || !normalizedPrompt) return false;
  const intent: CaptureContextIntent = { issuedAt: now(), prompt: normalizedPrompt, version: 1 };
  try {
    target.setItem(CAPTURE_CONTEXT_STORAGE_KEY, JSON.stringify(intent));
    return true;
  } catch {
    return false;
  }
}

export function consumeCaptureContextIntent(
  storage?: SessionStorageLike,
  now: () => number = Date.now
) {
  const target = currentSessionStorage(storage);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(CAPTURE_CONTEXT_STORAGE_KEY);
    target.removeItem(CAPTURE_CONTEXT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CaptureContextIntent>;
    if (value.version !== 1 || typeof value.issuedAt !== "number" || typeof value.prompt !== "string") {
      return null;
    }
    const age = now() - value.issuedAt;
    if (age < 0 || age > CAPTURE_CONTEXT_MAX_AGE_MS) return null;
    const normalizedPrompt = value.prompt.normalize("NFC").trim().slice(0, 240);
    return normalizedPrompt || null;
  } catch {
    return null;
  }
}
