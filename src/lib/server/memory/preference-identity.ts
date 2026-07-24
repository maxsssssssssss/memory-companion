import { createHash } from "node:crypto";

export type PreferenceValue = "avoid" | "prefer";

export type PreferenceIdentity = {
  key: string;
  value: PreferenceValue;
  fingerprint: string;
};

type PreferenceTextSource = {
  title?: string;
  summary?: string;
  evidence?: Array<{ sourceType: string; quote: string }>;
};

const META_ONLY_KEYS = new Set([
  "偏好",
  "习惯",
  "饮食习惯",
  "个人偏好",
  "几个偏好",
  "几个习惯",
  "这些偏好",
  "这些习惯",
  "吗",
  "吧",
  "呢",
  "啊",
  "呀",
  "啦",
  "哦",
  "嗯"
]);

const assertionPatterns: Array<{ value: PreferenceValue; pattern: RegExp }> = [
  {
    value: "avoid",
    pattern: /(?:不太能接受|不能接受|无法接受|不太能吃|不能吃|不喜欢|不爱|不吃|避免|不想要|不要)(?<subject>[^，,。！？!?；;\n]{1,48})/giu
  },
  {
    value: "prefer",
    pattern: /(?:更喜欢|最喜欢|特别喜欢|通常喜欢|一般喜欢|偏好(?:是|为|:|：)?|更倾向(?:于)?|倾向(?:于)?|优先(?:选择|选|找)?)(?<subject>[^，,。！？!?；;\n]{1,48})/giu
  },
  {
    value: "prefer",
    pattern: /(?:我|我们|你|你们|他|她|对方)?(?:平时|通常|一般)(?:会)?(?:把)?(?<subject>[^，,。！？!?；;\n]{2,48})/giu
  },
  {
    value: "prefer",
    pattern: /(?:我|我们|你|你们|他|她|对方)习惯(?:于)?(?<subject>[^，,。！？!?；;\n]{1,48})/giu
  },
  {
    value: "avoid",
    pattern: /\b(?:do not|don't|does not|doesn't|avoid)\s+(?<subject>[^,.!?;\n]{1,64})/giu
  },
  {
    value: "prefer",
    pattern: /\b(?:prefer|usually choose|usually use|usually take)\s+(?<subject>[^,.!?;\n]{1,64})/giu
  }
];

function normalizePreferenceKey(value: string) {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/^(?:的|去|吃|喝|选|选择|找|用|坐在|待在|把|喜欢)+/gu, "")
    .replace(/(?:的话|的时候|为主|一点|一些)$/gu, "")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .replace(/^(?:我|我们|你|你们|他|她|对方)+/gu, "")
    .trim();
  if (!normalized || normalized.length > 64 || META_ONLY_KEYS.has(normalized)) {
    return null;
  }
  if (/(?:和|以及|还有|并且|同时)/u.test(normalized)) {
    return null;
  }
  if (!/[\p{Letter}\p{Number}]/u.test(normalized)) {
    return null;
  }
  return normalized;
}

export function extractPreferenceIdentities(value: string) {
  const byFingerprint = new Map<string, PreferenceIdentity>();
  for (const { value: preferenceValue, pattern } of assertionPatterns) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const key = normalizePreferenceKey(match.groups?.subject ?? "");
      if (!key) continue;
      const fingerprint = `${preferenceValue}\u001f${key}`;
      byFingerprint.set(fingerprint, { key, value: preferenceValue, fingerprint });
    }
  }
  return [...byFingerprint.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export function hasConcretePreferenceIdentity(value: string) {
  return extractPreferenceIdentities(value).length > 0;
}

export function preferenceIdentitiesFromMemory(memory: PreferenceTextSource) {
  const canonicalTitle = memory.title?.match(/^明确偏好表达[：:](.+)$/u)?.[1] ?? "";
  const titleIdentities = extractPreferenceIdentities(canonicalTitle);
  if (titleIdentities.length === 1) {
    return titleIdentities;
  }
  const summaryIdentities = extractPreferenceIdentities(memory.summary ?? "");
  if (summaryIdentities.length === 1) {
    return summaryIdentities;
  }
  const transcriptQuotes = (memory.evidence ?? [])
    .filter((evidence) => evidence.sourceType === "transcript")
    .map((evidence) => evidence.quote);
  const texts = transcriptQuotes.length > 0 ? transcriptQuotes : [memory.title ?? "", memory.summary ?? ""];
  const byFingerprint = new Map<string, PreferenceIdentity>();
  for (const text of texts) {
    for (const identity of extractPreferenceIdentities(text)) {
      byFingerprint.set(identity.fingerprint, identity);
    }
  }
  return [...byFingerprint.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

export function preferenceIdentityHash(identity: PreferenceIdentity) {
  return createHash("sha256").update(identity.fingerprint).digest("hex").slice(0, 16);
}

export function preferenceIdentityLabel(identity: PreferenceIdentity) {
  return identity.value === "avoid" ? `不喜欢${identity.key}` : `更喜欢${identity.key}`;
}
