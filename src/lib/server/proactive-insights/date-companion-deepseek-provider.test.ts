// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DateCompanionProactiveValueContextSchema,
  type DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";

import {
  createDeepseekDateCompanionProactiveValueProvider,
  DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION,
  frameDateCompanionProactiveValueDraft,
  validateCanonicalDateCompanionProactiveValue
} from "./deepseek-provider";

type EvidenceOrigin = "direct_conversation" | "user_reflection";

function evidence(input: {
  index?: number;
  date?: string;
  origin?: EvidenceOrigin;
  subject?: "self" | "companion" | "both";
}) {
  const index = input.index ?? 1;
  const origin = input.origin ?? "direct_conversation";
  return {
    evidenceId: `evidence_${index}`,
    uploadId: `upload_${index}`,
    sourceSegmentId: `segment_${index}`,
    recordingDate: input.date ?? "2026-08-19",
    quote: origin === "user_reflection"
      ? "用户在复盘里说 Alice 可能想换工作。"
      : "Ta 说周末想去看展。",
    contentDigest: String(index).repeat(64),
    origin,
    subject: input.subject ?? "companion" as const
  };
}

function currentContext(): DateCompanionProactiveValueContext {
  return DateCompanionProactiveValueContextSchema.parse({
    schemaVersion: 1,
    scope: "current_interaction",
    relationshipId: "relationship_1",
    interactionId: "interaction_1",
    mappingVersion: 3,
    interactionVersion: 2,
    confirmationFingerprint: "f".repeat(64),
    evidence: [evidence({ origin: "direct_conversation" })]
  });
}

function relationshipContext(input: {
  origins?: EvidenceOrigin[];
  dates?: string[];
  subjects?: Array<"self" | "companion" | "both">;
} = {}): DateCompanionProactiveValueContext {
  const origins = input.origins ?? ["user_reflection"];
  return DateCompanionProactiveValueContextSchema.parse({
    schemaVersion: 1,
    scope: "person_relationship",
    relationshipId: "relationship_1",
    personId: "person_companion",
    mappingVersion: 3,
    evidence: origins.map((origin, index) => evidence({
      index: index + 1,
      origin,
      date: input.dates?.[index],
      subject: input.subjects?.[index]
    }))
  });
}

function unreachableCurrentReflectionContext() {
  return {
    ...currentContext(),
    evidence: [evidence({ origin: "user_reflection" })]
  } as unknown as DateCompanionProactiveValueContext;
}

function naturalDraft(input: {
  evidenceIds?: string[];
  questions?: string[];
} = {}) {
  return {
    observation: "这件事值得下次继续留意。\n目前还只是一个局部线索。",
    suggestedQuestions: input.questions ?? ["后来有没有新的安排？"],
    reason: "它比较具体，而且可以回到原始来源继续核对。",
    evidenceIds: input.evidenceIds ?? ["evidence_1"],
    confidence: 0.68,
    caution: "信息还有限，先保留为待确认线索。"
  };
}

type ProviderDependencies = NonNullable<Parameters<
  typeof createDeepseekDateCompanionProactiveValueProvider
>[0]>;
type ClientFactory = NonNullable<ProviderDependencies["clientFactory"]>;
type Client = ReturnType<ClientFactory>;
type Request = Parameters<Client["chat"]["completions"]["create"]>[0];

const original = {
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_MODEL,
  retries: process.env.PROACTIVE_INSIGHT_MAX_RETRIES
};

beforeEach(() => {
  process.env.DEEPSEEK_API_KEY = "test_key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  process.env.PROACTIVE_INSIGHT_MAX_RETRIES = "9";
});

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    const envName = {
      apiKey: "DEEPSEEK_API_KEY",
      baseUrl: "DEEPSEEK_BASE_URL",
      model: "DEEPSEEK_MODEL",
      retries: "PROACTIVE_INSIGHT_MAX_RETRIES"
    }[key] as string;
    if (value === undefined) delete process.env[envName];
    else process.env[envName] = value;
  }
});

describe("Date Companion DeepSeek proactive value provider", () => {
  it("accepts the production current-interaction shape and keeps the strict request contract", async () => {
    const create = vi.fn(async (_request: Request) => ({
      choices: [{ message: { content: JSON.stringify(naturalDraft()) } }]
    }));
    const clientFactory = vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } }));
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory,
      now: () => 1_000,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const result = await provider.generate({
      context: currentContext(),
      sourceFingerprint: "a".repeat(64)
    });

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://api.deepseek.com",
      maxRetries: 0
    }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: "deepseek-v4-flash",
      stream: false,
      temperature: 0.1,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" }
    }));
    const prompt = String((create.mock.calls[0]?.[0].messages as Array<{ content: string }>)
      .map((message) => message.content).join("\n"));
    expect(prompt).toContain(
      "observation、suggestedQuestions、reason、evidenceIds、confidence、caution 六个字段"
    );
    expect(prompt).toContain("服务器会在 evidenceIds allowlist 校验后");
    expect(prompt).toContain("不要在每个字段机械重复来源前缀");
    expect(result.status).toBe("generated");
    expect(Object.keys(result.value ?? {}).sort()).toEqual([
      "caution",
      "confidence",
      "evidenceIds",
      "observation",
      "reason",
      "suggestedQuestions"
    ]);
    expect(result.value).toMatchObject({
      observation: expect.stringMatching(/^在 2026-08-19 的交流记录中提到：/u),
      reason: expect.stringMatching(/^基于 2026-08-19 的交流记录：/u),
      caution: expect.stringContaining("这条派生提示不是新增第三方事实")
    });
    expect(result.value?.suggestedQuestions).toEqual([
      expect.stringMatching(/^关于 2026-08-19 的交流记录中提到的内容，/u)
    ]);
  });

  it("rejects current-interaction user reflection before any provider request", async () => {
    const create = vi.fn();
    const warn = vi.fn();
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn }
    });
    const result = await provider.generate({
      context: unreachableCurrentReflectionContext(),
      sourceFingerprint: "b".repeat(64)
    });

    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "fallback",
      value: null,
      failureCode: "unsafe_source_attribution",
      sourceDiagnostic: {
        ruleVersion: 4,
        scopeOriginMismatch: true,
        referencedOrigins: ["user_reflection"],
        unsafeFields: []
      }
    });
    const log = String(warn.mock.calls[0]?.[0]);
    expect(log).toContain("scope_origin_mismatch=true");
    expect(log).not.toContain("Alice");
    expect(log).not.toContain("用户在复盘里说");
  });

  it("frames natural person-relationship reflection text and both questions on the server", () => {
    const context = relationshipContext({ origins: ["user_reflection"] });
    const framed = frameDateCompanionProactiveValueDraft({
      context,
      value: naturalDraft({
        questions: [
          "下次聊到工作时，要不要温和问问近况？",
          "你还想先确认哪一部分？"
        ]
      })
    });

    expect(framed.failureCode).toBeUndefined();
    expect(framed.diagnostic).toEqual({
      ruleVersion: 4,
      scopeOriginMismatch: false,
      failedAttribution: false,
      unsafeFields: [],
      sourceMarkerFields: [],
      certaintyFields: [],
      normalizedSourceFields: [],
      cautionBoundaryMissing: true,
      cautionSourceNormalized: false,
      referencedOrigins: ["user_reflection"]
    });
    expect(framed.value).toMatchObject({
      observation: expect.stringMatching(/^你在 2026-08-19 的复盘中提到：/u),
      reason: expect.stringMatching(/^基于你在 2026-08-19 的复盘：/u),
      caution: expect.stringContaining("不是 Ta/第三方已确认的直接事实或原话")
    });
    expect(framed.value?.suggestedQuestions).toHaveLength(2);
    for (const question of framed.value?.suggestedQuestions ?? []) {
      expect(question).toMatch(/^关于你在 2026-08-19 的复盘中提到的内容，/u);
    }
    expect(validateCanonicalDateCompanionProactiveValue({
      context,
      value: framed.value
    })).toMatchObject({
      value: framed.value,
      diagnostic: { cautionBoundaryMissing: false, unsafeFields: [] }
    });
  });

  it("accepts the production person-relationship reflection prompt shape", async () => {
    const create = vi.fn(async (_request: Request) => ({
      choices: [{ message: { content: JSON.stringify({
        ...naturalDraft(),
        reason: "基于你的复盘，这件事值得继续留意。",
        caution: "基于你的复盘，这条线索仍需核实。"
      }) } }]
    }));
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const result = await provider.generate({
      context: relationshipContext({ origins: ["user_reflection"] }),
      sourceFingerprint: "9".repeat(64)
    });
    const prompt = String((create.mock.calls[0]?.[0].messages as Array<{ content: string }>)
      .map((message) => message.content).join("\n"));
    expect(create).toHaveBeenCalledTimes(1);
    expect(prompt).toContain("scope=person_relationship");
    expect(prompt).toContain("personId=person_companion");
    expect(prompt).toContain("user_reflection：用户事后复盘中的转述");
    expect(prompt).toContain("caution 只写来源中性的局限或下一步");
    expect(result).toMatchObject({
      status: "generated",
      value: {
        observation: expect.stringMatching(/^你在 2026-08-19 的复盘中提到：/u),
        caution: expect.stringContaining("不是 Ta/第三方已确认的直接事实或原话")
      },
      sourceDiagnostic: {
        unsafeFields: [],
        sourceMarkerFields: ["reason", "caution"],
        certaintyFields: [],
        normalizedSourceFields: ["reason", "caution"],
        cautionSourceNormalized: true
      }
    });
    expect(result.value?.reason).toContain("这条线索比较具体，适合后续核实");
    expect(result.value?.reason).not.toContain("基于你的复盘");
    expect(result.value?.caution).not.toContain("基于你的复盘");
  });

  it("frames mixed relationship sources together while scoping single-source selections independently", () => {
    const context = relationshipContext({
      origins: ["user_reflection", "direct_conversation"],
      dates: ["2026-08-18", "2026-08-19"]
    });
    const mixed = frameDateCompanionProactiveValueDraft({
      context,
      value: naturalDraft({ evidenceIds: ["evidence_1", "evidence_2"] })
    });
    expect(mixed.value).toMatchObject({
      observation: expect.stringContaining(
        "你在 2026-08-18 的复盘中提到相关内容；在 2026-08-19 的交流记录中也提到相关内容"
      ),
      reason: expect.stringContaining(
        "基于你在 2026-08-18 的复盘与 2026-08-19 的交流记录"
      ),
      caution: expect.stringContaining("复盘内容属于你的转述")
    });
    expect(mixed.value?.suggestedQuestions[0]).toContain(
      "关于你在 2026-08-18 的复盘中提到的内容，以及 2026-08-19 的交流记录中提到的内容"
    );
    expect(mixed.value?.caution).toContain("交流记录只支持当时直接出现的内容");
    expect(mixed.diagnostic.referencedOrigins).toEqual([
      "direct_conversation",
      "user_reflection"
    ]);

    const reflectionOnly = frameDateCompanionProactiveValueDraft({
      context,
      value: naturalDraft({ evidenceIds: ["evidence_1"] })
    });
    expect(reflectionOnly.value?.observation).toMatch(/^你在 2026-08-18 的复盘中提到：/u);
    expect(reflectionOnly.value?.observation).not.toContain("交流记录");

    const conversationOnly = frameDateCompanionProactiveValueDraft({
      context,
      value: naturalDraft({ evidenceIds: ["evidence_2"] })
    });
    expect(conversationOnly.value?.observation).toMatch(/^在 2026-08-19 的交流记录中提到：/u);
    expect(conversationOnly.value?.observation).not.toContain("复盘");
  });

  it("reuses complete direct, reflection and mixed canonical values without double framing", () => {
    const contexts = [
      currentContext(),
      relationshipContext({ origins: ["user_reflection"] }),
      relationshipContext({
        origins: ["user_reflection", "direct_conversation"],
        dates: ["2026-08-18", "2026-08-19"]
      })
    ];
    for (const context of contexts) {
      const evidenceIds = context.evidence.map((item) => item.evidenceId);
      const first = frameDateCompanionProactiveValueDraft({
        context,
        value: naturalDraft({ evidenceIds })
      });
      expect(first.value).not.toBeNull();
      const replay = frameDateCompanionProactiveValueDraft({ context, value: first.value });
      expect(replay.value).toEqual(first.value);
      expect(replay.diagnostic).toMatchObject({ unsafeFields: [], cautionBoundaryMissing: false });
    }
  });

  it("fails closed on wrong-source, partial, repeated or pre-appended source framing", () => {
    const directWrongSource = frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: { ...naturalDraft(), observation: "你在 2026-08-19 的复盘中提到：Ta 想去看展。" }
    });
    expect(directWrongSource).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: { unsafeFields: ["observation"] }
    });

    const mixedContext = relationshipContext({
      origins: ["user_reflection", "direct_conversation"],
      dates: ["2026-08-18", "2026-08-19"]
    });
    const mixedPartial = frameDateCompanionProactiveValueDraft({
      context: mixedContext,
      value: naturalDraft({
        evidenceIds: ["evidence_1", "evidence_2"],
        questions: ["关于你在 2026-08-18 的复盘中提到的内容，后来有新进展吗？"]
      })
    });
    expect(mixedPartial).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: { unsafeFields: ["suggestedQuestion:0"] }
    });

    const direct = frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: naturalDraft()
    });
    if (!direct.value) throw new Error("Expected canonical direct value");
    const repeated = frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: {
        ...direct.value,
        observation: `在 2026-08-19 的交流记录中提到：${direct.value.observation}`
      }
    });
    expect(repeated).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: { unsafeFields: ["observation"] }
    });

  });

  it("normalizes source-aware caution drafts without weakening the actual source boundary", () => {
    const cases = [
      {
        context: relationshipContext(),
        evidenceIds: ["evidence_1"],
        caution: "基于你的复盘，这条线索仍需核实。",
        boundary: "复盘内容属于你的转述，不是 Ta/第三方已确认的直接事实或原话。"
      },
      {
        context: relationshipContext(),
        evidenceIds: ["evidence_1"],
        caution: "交流记录中提到的内容仍需核实。",
        boundary: "复盘内容属于你的转述，不是 Ta/第三方已确认的直接事实或原话。"
      },
      {
        context: currentContext(),
        evidenceIds: ["evidence_1"],
        caution: "交流记录只支持当时直接出现的内容。",
        boundary: "交流记录只支持当时直接出现的内容；这条派生提示不是新增第三方事实。"
      },
      {
        context: relationshipContext({
          origins: ["user_reflection", "direct_conversation"],
          dates: ["2026-08-18", "2026-08-19"]
        }),
        evidenceIds: ["evidence_1", "evidence_2"],
        caution: "复盘内容属于你的转述，仍需要继续观察。",
        boundary: "复盘内容属于你的转述，不是 Ta/第三方已确认的直接事实或原话；交流记录只支持当时直接出现的内容，这条派生提示不是新增第三方事实。"
      }
    ];

    for (const testCase of cases) {
      const result = frameDateCompanionProactiveValueDraft({
        context: testCase.context,
        value: {
          ...naturalDraft({ evidenceIds: testCase.evidenceIds }),
          caution: testCase.caution
        }
      });
      expect(result.failureCode).toBeUndefined();
      expect(result.diagnostic).toMatchObject({
        failedAttribution: false,
        unsafeFields: [],
        sourceMarkerFields: ["caution"],
        certaintyFields: [],
        normalizedSourceFields: ["caution"],
        cautionSourceNormalized: true
      });
      expect(result.value?.caution).toBe(`信息仍有限，需要继续核实。${testCase.boundary}`);
      expect(result.value?.caution).not.toContain(testCase.caution);
      expect(result.value?.caution.split(testCase.boundary)).toHaveLength(2);
    }
  });

  it("normalizes source-aware reason drafts while keeping observation and questions strict", () => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: {
        ...naturalDraft(),
        reason: "基于 2026-08-19 的交流记录：这件事值得留意。"
      }
    });
    expect(result.failureCode).toBeUndefined();
    expect(result.diagnostic).toMatchObject({
      failedAttribution: false,
      unsafeFields: [],
      sourceMarkerFields: ["reason"],
      certaintyFields: [],
      normalizedSourceFields: ["reason"],
      cautionSourceNormalized: false
    });
    expect(result.value?.reason).toBe(
      "基于你在 2026-08-19 的复盘：这条线索比较具体，适合后续核实。"
    );
    expect(result.value?.reason).not.toContain("交流记录");
  });

  it("still fails closed when a source-aware caution upgrades uncertainty into fact", () => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: {
        ...naturalDraft(),
        caution: "基于你的复盘，Ta 已经决定换工作。"
      }
    });
    expect(result).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: {
        unsafeFields: ["caution"],
        sourceMarkerFields: ["caution"],
        certaintyFields: ["caution"],
        normalizedSourceFields: [],
        cautionSourceNormalized: false
      }
    });

    const reasonResult = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: {
        ...naturalDraft(),
        reason: "基于你的复盘，Ta 已经决定换工作。"
      }
    });
    expect(reasonResult).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: {
        unsafeFields: ["reason"],
        sourceMarkerFields: ["reason"],
        certaintyFields: ["reason"],
        normalizedSourceFields: [],
        cautionSourceNormalized: false
      }
    });
  });

  it("accepts natural Chinese punctuation and line breaks without requiring attribution regexes", () => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: naturalDraft({
        questions: ["要不要等合适的时候，再轻轻问一句？", "如果没有新进展，也先放一放，可以吗？"]
      })
    });
    expect(result.value).not.toBeNull();
    expect(result.diagnostic.unsafeFields).toEqual([]);
    expect(result.value?.suggestedQuestions).toHaveLength(2);
  });

  it("reports exact canonical attribution fields and a missing caution boundary without text", () => {
    const result = validateCanonicalDateCompanionProactiveValue({
      context: currentContext(),
      value: naturalDraft()
    });
    expect(result).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: {
        ruleVersion: 4,
        scopeOriginMismatch: false,
        failedAttribution: true,
        unsafeFields: ["observation", "suggestedQuestion:0", "reason", "caution"],
        cautionBoundaryMissing: true,
        referencedOrigins: ["direct_conversation"]
      }
    });
  });

  it.each([
    ["observation", { observation: "基于你的复盘，Alice 已确认会换工作。" }, "observation"],
    ["suggestedQuestion:0", { suggestedQuestions: ["Alice 一定会换工作吗？"] }, "suggestedQuestion:0"],
    ["suggestedQuestion:1", {
      suggestedQuestions: ["你想先确认哪一部分？", "Ta 肯定已经作出决定了吗？"]
    }, "suggestedQuestion:1"],
    ["reason", { reason: "Ta 确定会离职，所以这很重要。" }, "reason"],
    ["caution", { caution: "对方肯定已经作出决定。" }, "caution"]
  ])("rejects certainty escalation in %s even when source wording is present", (_label, override, field) => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: { ...naturalDraft(), ...override }
    });
    expect(result).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: {
        ruleVersion: 4,
        failedAttribution: true,
        unsafeFields: [field]
      }
    });
  });

  it("allows a genuine question about whether something was confirmed", () => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: naturalDraft({ questions: ["Alice 是否已经确认了下一步安排？"] })
    });
    expect(result.value).not.toBeNull();
    expect(result.diagnostic.unsafeFields).toEqual([]);
  });

  it.each([
    "Alice 已经决定换工作。",
    "Alice 已经作出决定要换工作。",
    "Alice 已决定换工作。",
    "Alice 确认要换工作。",
    "Alice 确认将换工作。",
    "Alice 明确表示会换工作。",
    "Alice 明确表示将换工作。",
    "Alice 已经确定会换工作。"
  ])("rejects the expanded third-party certainty assertion: %s", (observation) => {
    expect(frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: { ...naturalDraft(), observation }
    })).toMatchObject({
      value: null,
      failureCode: "unsafe_source_attribution",
      diagnostic: { unsafeFields: ["observation"] }
    });
  });

  it.each([
    "Alice 并未确认要换工作。",
    "Alice 是否已经决定换工作？",
    "待核实 Alice 确认要换工作的说法。",
    "Alice 可能已经决定换工作。"
  ])("keeps negated, questioned or tentative reflection wording: %s", (observation) => {
    const result = frameDateCompanionProactiveValueDraft({
      context: relationshipContext(),
      value: { ...naturalDraft(), observation }
    });
    expect(result.value).not.toBeNull();
    expect(result.diagnostic.unsafeFields).toEqual([]);
  });

  it("does not apply the reflection third-party certainty guard to direct records or self commitments", () => {
    expect(frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: { ...naturalDraft(), observation: "Ta 已经决定周末去看展。" }
    }).value).not.toBeNull();
    expect(frameDateCompanionProactiveValueDraft({
      context: relationshipContext({ subjects: ["self"] }),
      value: { ...naturalDraft(), observation: "我已经决定周末去看展。" }
    }).value).not.toBeNull();
  });

  it("keeps allowlist, strict schema and date-language gates", () => {
    expect(frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: naturalDraft({ evidenceIds: ["invented"] })
    })).toMatchObject({ value: null, failureCode: "invalid_evidence" });
    expect(frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: { ...naturalDraft(), evidenceIds: ["evidence_1", "evidence_1"] }
    })).toMatchObject({ value: null, failureCode: "invalid_schema" });
    expect(frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: { ...naturalDraft(), extra: "not allowed" }
    })).toMatchObject({ value: null, failureCode: "invalid_schema" });
    expect(frameDateCompanionProactiveValueDraft({
      context: currentContext(),
      value: { ...naturalDraft(), observation: "这件事再次出现。" }
    })).toMatchObject({ value: null, failureCode: "unsafe_date_language" });

    const threeDates = relationshipContext({
      origins: ["direct_conversation", "direct_conversation", "direct_conversation"],
      dates: ["2026-08-17", "2026-08-18", "2026-08-19"]
    });
    expect(frameDateCompanionProactiveValueDraft({
      context: threeDates,
      value: { ...naturalDraft({ evidenceIds: ["evidence_1", "evidence_2", "evidence_3"] }), observation: "这形成了固定模式。" }
    })).toMatchObject({ value: null, failureCode: "unsafe_date_language" });
    expect(frameDateCompanionProactiveValueDraft({
      context: threeDates,
      value: { ...naturalDraft({ evidenceIds: ["evidence_1", "evidence_2", "evidence_3"] }), observation: "这暂时可以作为待观察的模式线索。" }
    }).value).not.toBeNull();
  });

  it("returns field-only diagnostics without logging prompt, Evidence or model text", async () => {
    const unsafeDraft = {
      ...naturalDraft(),
      reason: "Alice 已确认会离职。"
    };
    const create = vi.fn(async (_request: Request) => ({
      choices: [{ message: { content: JSON.stringify(unsafeDraft) } }]
    }));
    const warn = vi.fn();
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn }
    });
    const result = await provider.generate({
      context: relationshipContext(),
      sourceFingerprint: "c".repeat(64)
    });

    expect(result).toMatchObject({
      status: "fallback",
      value: null,
      failureCode: "unsafe_source_attribution",
      sourceDiagnostic: {
        ruleVersion: 4,
        scopeOriginMismatch: false,
        failedAttribution: true,
        unsafeFields: ["reason"],
        cautionBoundaryMissing: true,
        referencedOrigins: ["user_reflection"]
      }
    });
    const log = String(warn.mock.calls[0]?.[0]);
    expect(log).toContain("unsafe_fields=reason");
    expect(log).toContain("certainty_fields=reason");
    expect(log).toContain("referenced_origins=user_reflection");
    expect(log).not.toContain(unsafeDraft.reason);
    expect(log).not.toContain("用户在复盘里说");
    expect(log).not.toContain("Allowed evidence IDs");
  });

  it("fails closed for unknown origin before provider access", async () => {
    const create = vi.fn();
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const result = await provider.generate({
      context: {
        ...relationshipContext({ origins: ["direct_conversation"] }),
        evidence: [{ ...evidence({}), origin: "unknown" }]
      } as unknown as DateCompanionProactiveValueContext,
      sourceFingerprint: "d".repeat(64)
    });
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "fallback",
      value: null,
      failureCode: "unsafe_source_attribution",
      sourceDiagnostic: { referencedOrigins: ["unknown"], ruleVersion: 4 }
    });
  });

  it("returns fallback after one provider failure without retrying", async () => {
    const create = vi.fn(async (_request: Request) => {
      throw new Error("provider unavailable");
    });
    const provider = createDeepseekDateCompanionProactiveValueProvider({
      clientFactory: vi.fn<ClientFactory>(() => ({ chat: { completions: { create } } })),
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    const result = await provider.generate({
      context: currentContext(),
      sourceFingerprint: "e".repeat(64)
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "fallback",
      value: null,
      failureCode: "api_error"
    });
  });

  it("uses source framing rule version 4", () => {
    expect(DATE_COMPANION_PROACTIVE_SOURCE_ATTRIBUTION_VERSION).toBe(4);
  });
});
