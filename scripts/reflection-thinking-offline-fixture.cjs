// Test-runner preload only. No production feature flag or runtime fallback.
// The real SDK/action parser/runtime/ledger still execute; no model socket exists.
const originalFetch = globalThis.fetch.bind(globalThis);
let syntheticCalls = 0;
const respond = (reply, suggestions = []) => ({ tool: "respond", args: { reply, understanding: reply,
  judgments: ["待确认：最终展示内容还需要你选择。"], suggestions: suggestions.map(text => ({ text, kind: "action" })) } });
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url !== "https://tokenhub.vision-intelligence.tech/v1/responses") return originalFetch(input, init);
  if (process.env.OPENAI_API_KEY !== "offline-thinking-synthetic-key" || !process.env.THINKING_P1_E2E_ARTIFACT_DIR)
    throw new Error("Offline thinking fixture requires an isolated runner");
  const request = new Request(input, init), body = await request.json();
  const userPrompt = body.input.find(message => message.role === "user").content;
  let payload; try { payload = JSON.parse(userPrompt); } catch { payload = null; }
  const goal = payload?.goal ?? userPrompt;
  let action;
  if (process.env.THINKING_P3_E2E === "1") {
    require("node:fs").appendFileSync(require("node:path").join(process.env.THINKING_P1_E2E_ARTIFACT_DIR, "p3-inputs.jsonl"), JSON.stringify({ index: syntheticCalls + 1, payload, userPrompt: payload ? undefined : userPrompt }) + "\n");
    if (!payload?.observation) action = { answer: "旧对话可以继续。按你当前表达比较取舍，今天不安排计划。", personalContextClaims: [], interpretations: ["这是基于当前讨论的解释。"], hypotheses: [] };
    else if (/撤回|仅根据当前/u.test(goal)) action = respond("已仅根据当前对话继续。你新的约束和改选理由保留，今天只讨论，不生成行动安排。");
    else {
      const options = payload.observation.matter.comparison?.options ?? [];
      const source = payload.observation.linkedRecords?.[0]?.text ?? "没有获准卡片";
      action = respond(`比较这两种表达方式。获准卡片内容：${source}。可以先有倾向，不要求现在安排计划。`);
      action.args.comparison = { question: "作品展示怎样表达？", dimensions: ["表达过程", "准备时间"], options: [
        { ...(options[0] ? { id: options[0].id } : {}), name: "方案A", content: `快速概览；依据：${source}`, reasons: ["易于浏览"], limits: ["过程较少"], costs: ["删减素材"], unknowns: ["观众需求"] },
        { ...(options[1] ? { id: options[1].id } : {}), name: "方案B", content: "完整讲述判断过程", reasons: ["能解释取舍"], limits: ["需要素材"], costs: ["整理时间"], unknowns: ["材料完整性"] },
      ], recommendation: null };
    }
  }
  else if (process.env.THINKING_P2_E2E === "1" && payload.observation.matter.question.startsWith("周末去图书馆读书，还是在家做饭？")) {
    const { matter } = payload.observation;
    const previous = matter.comparison?.options ?? [];
    const lunch = goal.includes("周六下午有家庭聚会") && goal.includes("提前准备午饭");
    action = respond(lunch ? "周六下午的家庭聚会需要提前备餐。根据这个条件更推荐在家做饭。" : "去图书馆适合安静阅读，在家做饭便于照顾家人。");
    action.args.comparison = {
      // Exercise both the new omission and an older model's incorrect but well-formed title.
      ...(lunch ? { question: "周日下午的上午安排" } : {}),
      dimensions: ["准备时间", "阅读环境"],
      options: ["去图书馆读书", "在家做饭"].map((name, i) => ({
        ...(previous[i] ? { id: previous[i].id } : {}), name, content: name,
        reasons: [i ? (lunch ? "在家可以提前准备家庭聚会的午饭。" : "在家时间更灵活。") : "图书馆适合安静阅读。"],
        limits: i === 0 && lunch ? ["外出时段要避开备餐时间。"] : [], costs: [], unknowns: ["具体可用时间"],
      })),
      recommendation: lunch ? { optionId: previous[1].id, text: "备餐条件下推荐在家做饭。" } : null,
    };
  }
  else if (process.env.THINKING_P2_E2E === "1") {
    const matter = payload.observation.matter;
    const options = matter.comparison?.options ?? [];
    const comparison = {
      question: "作品应该先快速发布，还是先完整表达？",
      dimensions: ["可用时间", "表达深度"],
      options: [
        { ...(options[0] ? { id: options[0].id } : {}), name: options[0]?.name ?? "方案A", content: "先发布一页作品概览。", reasons: ["可以更早获得反馈"], limits: ["过程表达较少"], costs: ["需要删减内容"], unknowns: ["观众是否需要过程细节"] },
        { ...(options[1] ? { id: options[1].id } : {}), name: options[1]?.name ?? "方案B", content: "围绕一件作品写完整的过程。", reasons: ["更清楚展示判断过程"], limits: ["准备时间较长"], costs: ["需要整理素材"], unknowns: ["素材是否齐全"] },
      ],
      recommendation: null,
    };
    if (/比较|方案|新约束/u.test(goal)) {
      const changed = /新约束|改选/u.test(goal);
      action = respond(changed ? "新的展示约束使表达过程更重要。现在按你选的方案B重新讨论内容，旧尝试及反馈保留，不视为完成。" : "方案A更快获得反馈，方案B更能表达过程。比较维度是你现在的可用时间和表达深度，可以倾向、选择，也可以暂不决定。");
      action.args.comparison = comparison;
      if (!/不要.*计划|只比较|不安排/u.test(goal)) action.args.suggestions = [{ text: changed ? "为方案B列出一件作品的关键过程素材，是否执行由你决定。" : "花十分钟列出两件作品的标题，作为可选小尝试。", kind: "action" }];
    } else action = respond("这件事独立保留，先讨论当前表达，不会将内容写进另一件事。");
    // Only metadata is kept: this makes source authorization and current business
    // progress observable without recording private source bodies in the fixture log.
    require("node:fs").appendFileSync(require("node:path").join(process.env.THINKING_P1_E2E_ARTIFACT_DIR, "p2-observations.jsonl"), JSON.stringify({
      matterId: matter.id, userChoice: matter.userChoice, optionIds: options.map(option => option.id), linkedSources: matter.linkedSources,
      linkedRecords: (payload.observation.linkedRecords ?? []).map(record => ({ ref: record.ref,
        textSha256: require("node:crypto").createHash("sha256").update(record.text).digest("hex") })),
      historyCount: payload.observation.historyCount,
    }) + "\n");
  }
  else if (/技术其实没问题|不知道展示什么内容/u.test(goal)) action = respond("这次尝试说明技术已经可行。现在改为讨论展示内容：选一件作品，说明你想让别人看见的过程和结果。", ["选一件作品，写出最想展示的过程和结果。"]);
  else if (/功能范围太大/u.test(goal)) action = respond("先把范围缩到一个页面，只呈现一件作品，看看真正卡在哪里。", ["先做一个最小页面，只展示一件作品。"]);
  else if (/总是修改作品计划/u.test(goal)) action = { wait: { kind: "feedback", message: "你最难开始的是功能范围太大，还是不确定展示什么？" } };
  else if (/比较两个方向/u.test(goal)) action = respond("方向一更快验证，方向二表达空间更大。前者省时间，后者需要更多准备；还不知道你更在意速度还是表达深度。今天只比较，不安排计划。");
  else if (/没有历史|没有资料/u.test(goal)) action = respond("没有可用历史也可以讨论。就从你现在给出的两个方向和最在意的标准开始，我不会假定你过去的选择。");
  else if (/纠正|展示内容/u.test(goal)) action = respond("已按你的纠正转向展示内容。先讨论想让读者看见什么，而不是继续扩大技术范围。");
  else action = respond("可以从你当前最关心的取舍聊起；不需要现在就安排下一步。");
  syntheticCalls += 1;
  require("node:fs").appendFileSync(require("node:path").join(process.env.THINKING_P1_E2E_ARTIFACT_DIR, "synthetic-calls.jsonl"),
    JSON.stringify({ index: syntheticCalls, kind: "synthetic_transport", model: body.model, retryCount: request.headers.get("x-stainless-retry-count"), action: action.tool ?? (action.wait ? "wait" : "finish") }) + "\n");
  const event = { type: "response.completed", response: { id: `offline-${syntheticCalls}`, status: "completed", error: null, incomplete_details: null,
    usage: { input_tokens: 100, output_tokens: 50 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(action) }] }] } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream", "x-request-id": `offline-${syntheticCalls}` } });
};
