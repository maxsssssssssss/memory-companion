/** Synthetic fixture authoring only. Never generates a quiz or calls a Provider. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LearningRepository } from "../../src/lib/server/learning/repository";
import { LearningFrameworkRepository } from "../../src/lib/server/learning/framework-repository";

const root = path.resolve(process.env.AGENT_TRIAL_DIR ?? "output/agent-a0-a1-offline");
const runtime = JSON.parse(readFileSync(path.join(root, "runtime.json"), "utf8")) as { base: string; dataRoot: string; inviteCode: string };
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(runtime.base).hostname), "loopback_only");
assert.equal(path.resolve(runtime.dataRoot), path.join(root, "data"), "isolated_data_required");
mkdirSync(path.join(root, "screenshots"), { recursive: true });
const paragraphs = [
  "合成教材：集合、交集与并集。本材料由验收脚本手工编写，仅用于隔离软件验证；不是教学效果研究或真实学生资料。以下定义与算例按通常的有限集合约定。",
  "集合由确定的元素组成，花括号表示一个集合。同一元素重复写出不会增加元素个数，元素的书写顺序不影响集合。例如 {1, 2, 2} 与 {2, 1} 都是含两个元素的集合。空集 ∅ 不含任何元素。",
  "交集 A∩B 包含同时属于 A 和 B 的元素。判断一个元素是否在交集中，需要两个归属条件同时成立。若 A={1,2,3}，B={3,4}，则 A∩B={3}。没有共同元素时交集为空集。",
  "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。一个元素只出现一次。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。把元素 3 写两次不构成两个不同元素。",
  "比较交集和并集：共同元素 3 同时属于上例的交集与并集；只属于 A 的元素 1 在并集中而不在交集中。交集强调共同满足，并集允许满足至少一个归属条件。A∩B 总是 A∪B 的子集。",
  "若 C={红,蓝}，D={蓝,绿}，则 C∩D={蓝}，C∪D={红,蓝,绿}。若 E={5}，F={6}，则 E∩F=∅，E∪F={5,6}。空交集不代表两个集合都为空。",
  "有限集合的并集元素个数满足 |A∪B|=|A|+|B|−|A∩B|。上例 |A|=3，|B|=2，|A∩B|=1，因此 |A∪B|=4。减去交集数量是为消除对共同元素的一次重复计数；不能把交集数量当作并集数量。",
];
const source = paragraphs.join("\n\n");
const frozen = {
  version: 1, evidence: "手工合成教材与框架；真实生成的 Quiz 和解释另行记录；学生为固定策略模拟学生。",
  sourceSha256: createHash("sha256").update(source).digest("hex"), paragraphs,
  studentPolicy: { A: "每题选择显示顺序中的第一个错误选项；不提示、不跳过、不揭示；由正式 choose/finish API 评分。", B: "每题选择既有正确选项；不提示、不跳过、不揭示；由正式 choose/finish API 评分。" },
  goals: { A: "我想复习集合的交集和并集，目前不清楚自己的薄弱点，请根据实际反馈帮助我复习。", B: "我不理解为什么交集是同时属于两个集合，而并集的或也包括同时属于两个集合。请先帮我理解这个概念，再根据我的反馈继续。" },
  feedbackAfterExplanation: "这个解释有帮助，我想做一组相关练习，再根据实际结果继续。",
};
const frozenPath = path.join(root, "frozen-inputs.json");
if (existsSync(frozenPath)) assert.deepEqual(JSON.parse(readFileSync(frozenPath, "utf8")), frozen, "frozen_fixture_changed");
else writeFileSync(frozenPath, JSON.stringify(frozen, null, 2));
writeFileSync(path.join(root, "synthetic-course.txt"), source);

type Account = { key: "A" | "B"; email: string; password: string; userId?: string; pageId: string; materialId: string; frameworkId: string; chapterId?: string; nodeIds?: string[] };
const accountsPath = path.join(root, "synthetic-accounts.json");
const accounts: Account[] = existsSync(accountsPath) ? JSON.parse(readFileSync(accountsPath, "utf8")) : (["A", "B"] as const).map(key => ({
  key, email: `agent-a0-a1-${key.toLowerCase()}-${randomUUID()}@synthetic.invalid`, password: `synthetic-only-${randomUUID()}`,
  pageId: randomUUID(), materialId: randomUUID(), frameworkId: randomUUID(),
}));
const save = () => writeFileSync(accountsPath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
save();

for (const [index, account] of accounts.entries()) {
  let cookie = "";
  async function api(route: string, method = "GET", data?: unknown) {
    const url = new URL(route, runtime.base);
    assert.equal(url.origin, runtime.base);
    assert(/^\/api\/(auth|learning)\//.test(url.pathname), "seed_api_scope_denied");
    const response = await fetch(url, { method, redirect: "error", headers: { ...(cookie ? { cookie } : {}), ...(data instanceof FormData ? {} : data === undefined ? {} : { "content-type": "application/json" }) },
      ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) }) });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length) cookie = setCookie.map(value => value.split(";")[0]).join("; ");
    const value = await response.json();
    assert(response.ok, `seed_http_${response.status}_${value.error ?? "failed"}`);
    return value;
  }
  if (!account.userId) {
    // Reconcile a lost registration response through login; never synthesize auth records.
    try { account.userId = (await api("/api/auth/login", "POST", { email: account.email, password: account.password })).user.id; }
    catch (error) {
      if (!String(error).includes("seed_http_401")) throw error;
      account.userId = (await api("/api/auth/register", "POST", { email: account.email, password: account.password, inviteCode: runtime.inviteCode, name: `合成学生 ${account.key}` })).user.id;
    }
    save();
  } else await api("/api/auth/login", "POST", { email: account.email, password: account.password });
  assert(account.userId);
  const pagePath = `/api/learning/pages/${account.pageId}`;
  const pages = (await api("/api/learning/pages")).pages as Array<{ id: string }>;
  if (!pages.some(page => page.id === account.pageId)) await api("/api/learning/pages", "POST", { id: account.pageId, title: `合成课程 · 集合复习 ${account.key}` });
  let page = (await api(pagePath)).page;
  if (!page.materials.some((material: { id: string }) => material.id === account.materialId)) {
    const form = new FormData();
    form.set("materials", JSON.stringify([{ id: account.materialId, title: "合成教材 · 集合、交集与并集", kind: "text" }]));
    form.append("files", new Blob([source], { type: "text/plain;charset=utf-8" }), "synthetic-sets.txt");
    form.set("intent", "save");
    page = (await api(pagePath + "/materials", "POST", form)).page;
  }
  if (!page.materials.some((material: { id: string; selected: boolean }) => material.id === account.materialId && material.selected))
    await api(pagePath, "PATCH", { revision: page.revision, materialIds: [account.materialId] });
  const accountRoot = path.join(runtime.dataRoot, "users", account.userId);
  assert(existsSync(path.join(accountRoot, "learning-organizer.sqlite")), "server_data_root_mismatch");
  const learning = new LearningRepository(accountRoot, account.userId);
  try {
    assert.equal(learning.source(account.pageId, account.materialId).text, source, "frozen_material_changed");
    const framework = new LearningFrameworkRepository(learning);
    const prior = framework.view(account.pageId);
    if (!prior.runs.some(run => run.id === account.frameworkId)) {
      framework.begin(account.pageId, { id: account.frameworkId, materialIds: [account.materialId] }, 48000);
      framework.validating(account.pageId, account.frameworkId);
      framework.complete(account.pageId, account.frameworkId, {
        overview: "手工合成框架：区分交集与并集，再理解去重计数。不是模型生成或教学效果验收。",
        chapters: [{ title: "集合的两种运算", explanation: "先判断元素归属，再比较集合及有限元素个数。", nodes: [
          { title: "交集与并集的归属条件", explanation: "交集要求同时属于两者；并集包含至少属于其中一者的元素。共同元素也在并集中。", supplement: null, sources: [2, 3, 4, 5].map(paragraph => ({ materialId: account.materialId, paragraph })) },
          { title: "空交集与并集去重计数", explanation: "没有共同元素时交集为空；并集仍包含两边元素。计算并集个数要减去共同元素的一次重复计数。", supplement: null, sources: [6, 7].map(paragraph => ({ materialId: account.materialId, paragraph })) },
        ] }],
      });
    }
    const chapter = framework.view(account.pageId).chapters.find(item => item.runId === account.frameworkId);
    assert(chapter, "synthetic_framework_incomplete");
    account.chapterId = chapter.id; account.nodeIds = chapter.nodes.map(node => node.id); save();
  } finally { learning.database.close(); }
  // Authenticated read-back proves the normal API sees the saved fixture.
  assert.equal((await api(pagePath + "/framework")).framework.chapters.length, 1);
  await api("/api/auth/logout", "POST");
  console.log(`[seed ${index + 1}/2] synthetic account ${account.key}: course and hand-authored framework saved; zero Provider calls`);
}
writeFileSync(path.join(root, "seed-result.json"), JSON.stringify({ status: "PASS", evidence: "synthetic_fixture", accounts: accounts.map(({ key, userId, pageId, materialId, chapterId, nodeIds }) => ({ key, userId, pageId, materialId, chapterId, nodeIds })), sourceSha256: frozen.sourceSha256, providerRequests: 0 }, null, 2));
