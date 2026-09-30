// Explicit test-process preload only. Never imported by application code.
// This intercepts SDK HTTP transport in memory; it is not a model/server/Provider.
// Next may normalize repeated --require options down to one in its dev child.
// Load the isolation guard here so the mock can never replace it in that child.
require("./learning-stage1-validation-guard.cjs");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.env.LEARNING_FRAMEWORK_MOCK_OUTPUT || "");
const workspaceOutput = path.resolve(process.cwd(), "output", "playwright") + path.sep;
if (!root.startsWith(workspaceOutput) || process.env.OPENAI_API_KEY !== "SYNTHETIC_FRAMEWORK_NO_REAL_KEY") {
  throw new Error("Synthetic framework preload requires an isolated output directory and synthetic credential");
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://company-asr.synthetic.invalid/api/ai/non-realtime-asr")) {
    const request = init?.body ? JSON.parse(init.body) : null;
    if (!request || !request.req_id.startsWith("learning_") || !request.audio_url.startsWith(process.env.SPEAKER_ASR_AUDIO_BASE_URL + "/api/learning/asr-audio/")) throw new Error("Unexpected synthetic ASR request");
    const audio = await originalFetch(request.audio_url);
    if (!audio.ok || (await audio.arrayBuffer()).byteLength === 0) throw new Error("Synthetic capability callback failed");
    fs.appendFileSync(path.join(root, "asr-mock-calls.jsonl"), JSON.stringify({ kind: "in_memory_asr_mock", callbackStatus: audio.status }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return new Response(JSON.stringify({ code: 0, data: { asr_result: { sentences: [
      { text: "[合成测试] 模拟转写：磁性并非所有金属共有。", timestamp: [{ start: 0, end: 400 }] },
      { text: "[合成测试] 模拟转写：注意英文术语 magnetism。", timestamp: [{ start: 500, end: 900 }] }
    ] } } }), { headers: { "content-type": "application/json" } });
  }
  if (url !== "https://tokenhub.vision-intelligence.tech/v1/responses") return originalFetch(input, init);
  const request = JSON.parse(init.body);
  if (request.model !== "deepseek-v4-pro" || request.tools || request.store !== false) throw new Error("Unexpected synthetic model request");
  const payload = JSON.parse(request.input.at(-1).content), { materials } = payload;
  if (!materials.length || materials.some((m) => !m.paragraphs.every((p) => p.text.includes("[合成测试]")))) throw new Error("Only explicitly synthetic materials allowed");
  fs.appendFileSync(path.join(root, "mock-calls.jsonl"), JSON.stringify({ kind: payload.count ? "quiz" : payload.node ? "node_qa" : payload.chapters ? "overview" : "framework", materials: materials.length, history: payload.history?.length }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  if (materials.some((m) => m.paragraphs.some((p) => p.text.includes("MOCK_FAIL")))) {
    return new Response(JSON.stringify({ error: { message: "Synthetic failure", type: "synthetic_error" } }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const value = payload.count ? { title: "[模拟题组] 条件与反例", reason: payload.count > 3 ? "[模拟] 依据仅支持3道不同题目。" : null,
    items: Array.from({length:Math.min(payload.count,3)},(_,i)=>({stem:`[模拟题目 ${i+1}] 不满足适用前提时如何处理？`,kind:i===0?"concept":i===1?"relationship":"application",
      options:[{id:"A",text:"不能应用规则",reason:"[模拟] 正确原因 SECRET_CORRECT"},{id:"B",text:"应用规则后不达标",reason:"[模拟] 混淆两种不同情形 SECRET_WRONG"}],correctOptionId:"A",explanation:"[模拟解析] 两种判断不能混为一谈。",hint:"[模拟提示] 先区分是否具备判断资格。",
      sources:[...materials.map(m=>({kind:"material",materialId:m.materialId,paragraph:m.paragraphs[0].number})),...(payload.extras??[]).map(e=>({kind:e.kind,id:e.id}))]})) }
    : payload.node ? { materialAnswer: `[模拟追问] ${payload.question}；材料内条件与反例分别保留。`,
    supplements: [{ kind: payload.action === "example" ? "example" : "explanation", text: "[模拟补充] 仅供教学交互验收，假设条件成立才适用。" }],
    items: [{ materialId: materials[0].materialId, paragraph: materials[0].paragraphs[0].number }] }
    : payload.chapters ? { summary: "[模拟关系] 两批内容互补，并保留不适用反例。", items: [{kind:"complement",title:"[模拟] 有依据的互补",explanation:"[模拟] 对照两批原段落，区分条件与反例。",
      chapterIds:[payload.chapters[0].id,payload.chapters.at(-1).id],sources:[payload.chapters[0].nodes[0].sources[0],payload.chapters.at(-1).nodes[0].sources[0]].map(({materialId,paragraph})=>({materialId,paragraph}))}] }
    : { overview: "[模拟生成] 本批材料的概念与关系，仅供交互验收。", chapters: materials.map((m) => ({
    title: `[模拟生成] ${m.title}`, explanation: "[模拟生成] 章节说明，不代表模型质量。",
    nodes: m.paragraphs.map((p) => ({ title: `[模拟生成] 第 ${p.number} 段知识点`, explanation: `[模拟生成] ${p.text}`,
      supplement: p.number === 2 ? "[模拟生成] 材料外基础解释示意" : null,
      sources: [{ materialId: m.materialId, paragraph: p.number }] }))
  })) };
  if(payload.count)for(const q of value.items){q.evidence=q.sources.map(source=>({source,quote:source.kind==='material'?materials.find(m=>m.materialId===source.materialId).paragraphs.find(p=>p.number===source.paragraph).text:payload.extras.find(e=>e.id===source.id).text}));for(const o of q.options)o.evidenceIndexes=q.evidence.map((_,i)=>i);}
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_synthetic", object: "response", status: "completed", error: null, incomplete_details: null,
    output: [{ id: "msg_synthetic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } } })}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });
};
