import type { PreparationItem, PreparationMessage, PreparationSource, PreparationView, PreviewClue, PreviewRecord, PreviewScenario, PreviewSnapshot } from "../prepare-notebook/model";

export const PREVIEW_NAMESPACE = "daily-brief.prepare-notebook.stage1.v1";
export const previewScenarios: PreviewScenario[] = [
  { id: "normal", name: "两页之间", description: "已经留下两件小事，接着聊下一次见面。", trigger: "继续发送一句话，修改候选后留下；查来源、刷新与历史重开。", group: "阅读与选择" },
  { id: "bottom-edit", name: "第三张便笺", description: "三条已留下的准备，检查底部原位编辑。", trigger: "滚到第三条→修改；无需补滚动即可保存或取消；查依据后返回。", group: "阅读与选择" },
  { id: "long-reply", name: "一段较长的回答", description: "当前模拟服务返回长正文和一条候选。", trigger: "发送后从回答开头阅读；上翻历史等待时不抢读点。", group: "异步与恢复", response: "long" },
  { id: "empty", name: "第一句话", description: "已有关系，还没有讨论或已选准备。", trigger: "示例只回填；首次发送才创建讨论。", group: "阅读与选择" },
  { id: "no-relationship", name: "还没有建立关系", description: "可以先从自己的表达开始。", trigger: "直接聊天；不提供人物历史材料，不虚构关系档案。", group: "资料与身份" },
  { id: "no-candidates", name: "只聊聊", description: "已有对话，这一轮没有可选建议。", trigger: "继续发送普通表达；不会每轮强制生成便笺。", group: "阅读与选择", response: "none" },
  { id: "one-candidate", name: "一个小主意", description: "一条未选建议，左页仍然空着。", trigger: "修改→保存，确认仍未选；再明确留下。", group: "阅读与选择" },
  { id: "three-candidates", name: "三种说法", description: "三条独立备选，不会自动成为准备。", trigger: "逐条编辑、选择或移除；模糊的“不错”不自动选用。", group: "阅读与选择", response: "three" },
  { id: "selected-edit", name: "改一改已留下的", description: "已选内容与聊天共用同一条目。", trigger: "从左页编辑并保存，两处同步且继续已选。", group: "阅读与选择" },
  { id: "select-failure", name: "留下时出错", description: "首次留下失败，原建议与文字都保留。", trigger: "留下→失败→重试，只有成功后才出现左页便笺。", group: "异步与恢复", failure: "select" },
  { id: "edit-failure", name: "修改未保存", description: "首次保存修改失败，编辑草稿不丢。", trigger: "修改→保存失败→再次保存；选用状态不变。", group: "异步与恢复", failure: "edit" },
  { id: "removed", name: "后来放下了", description: "既有从未选过的移除，也有选用后放下的。", trigger: "以前留下的保留撤回阅读状态；没有恢复按钮。", group: "历史与归属" },
  { id: "meetings", name: "这次与以前", description: "不同 meetingId 下的准备各有归属。", trigger: "切换以前留下的，旅行准备不会混入本次。", group: "历史与归属" },
  { id: "long", name: "写了很多的一页", description: "长标题、长正文、多条准备与较长对话。", trigger: "向上读旧消息后继续发送，使用新消息提示，不抢走位置。", group: "阅读与选择" },
  { id: "feedback", name: "回来记一下", description: "上次留下旅行，这次反馈只想安静陪一会儿。", trigger: "回来记一下→发送反馈，旧选择保留在原见面背景。", group: "历史与归属" },
  { id: "scope", name: "这次可以参考什么", description: "三份可选择的复盘与单独的长期材料读取选项。", trigger: "改变资料范围；来源资格同步变化，未授权资料不会引用。", group: "资料与身份" },
  { id: "no-material", name: "没有过往材料", description: "没有合格历史资料，仍能从当前表达聊。", trigger: "资料范围为空；发送后建议只依据当前输入。", group: "资料与身份" },
  { id: "linked", name: "关联一场复盘", description: "独立关联复盘与基础资料范围同时存在。", trigger: "取消关联不清除资料范围；撤回范围不取消独立关联。", group: "资料与身份" },
  { id: "unmapped", name: "人物待核对", description: "关系人物映射未确认，与录音说话人身份分开。", trigger: "过往长期线索不可用；已确认复盘仍可单独选入讨论。", group: "资料与身份" },
  { id: "read-failure", name: "读取未完成", description: "首轮读取失败，已有记录不消失。", trigger: "重新读取同一本本机手帐，不创建讨论。", group: "异步与恢复", failure: "read" },
  { id: "sources", name: "逐句核对", description: "回复和条目都有来源，多条来源各自署名。", trigger: "查来源→原记录片段→返回；输入与编辑选区保持。", group: "资料与身份" },
  { id: "long-sources", name: "读一张长插页", description: "同一条准备的两份长来源，插页内部阅读，不撑长便笺。", trigger: "打开第二条准备的依据，向下读→全文→返回来源→返回编辑；核对三处滚动与选区。", group: "资料与身份" },
  { id: "fragment-only", name: "只留下了片段", description: "本机没有全文，但已保存来源仍可阅读。", trigger: "查看已存片段；没有可用全文时不伪造全文入口。", group: "资料与身份" },
  { id: "invalid-source", name: "来源已撤回", description: "原文不可再显示，已选文字仍由用户拥有。", trigger: "查看失效说明；未选候选不可继续留下。", group: "资料与身份" },
  { id: "slow", name: "慢慢回应", description: "可控的约八秒本地慢响应。", trigger: "发送后继续阅读；可以取消等待，不撤回已发送消息。", group: "异步与恢复", response: "slow" },
  { id: "reply-failure", name: "回答中断", description: "消息已保存，首次回答失败。", trigger: "先重读确认失败，再以同一操作身份重试，不重复用户消息。", group: "异步与恢复", response: "failed" },
  { id: "unknown-result", name: "结果暂时未知", description: "本地服务已接收消息，首次请求无法确认结果。", trigger: "先重新读取；恢复同一结果，不再创建讨论或重复生成。", group: "异步与恢复", response: "unknown" },
  { id: "conflict", name: "另一处刚刚更新", description: "首次修改遇到版本冲突。", trigger: "重读当前版本后继续保存，保留输入草稿。", group: "异步与恢复", failure: "conflict" },
  { id: "late", name: "迟到的回复", description: "取消等待或切换讨论后，旧回复仍可能完成。", trigger: "发送→取消或切讨论→等待；旧回复只属于原讨论。", group: "异步与恢复", response: "late" },
  { id: "paused", name: "先到这里", description: "暂停的讨论仍保留全部准备与对话。", trigger: "继续发送恢复 active；暂停不等于完成。", group: "历史与归属" },
  { id: "history", name: "聊过的几页", description: "两份完整讨论与各自的见面归属。", trigger: "重开指定ID、各写未发输入、切回与刷新。", group: "历史与归属" },
  { id: "delete", name: "合上这一段", description: "可删除的隔离讨论，与原复盘分开。", trigger: "先取消确认，再确认删除；原来源记录仍在，草稿不复活。", group: "历史与归属" },
  { id: "other-person", name: "另一段关系", description: "林舟与陶艺主题，同一套规则和展示。", trigger: "核对姓名、来源、草稿和已选准备不串到小夏。", group: "资料与身份" },
];

const stamp = "2026-11-17T09:00:00+08:00";
const href = (record: string, segment: string) => `?record=${record}&segment=${segment}`;
const source = (id: string, interactionId: string, quote: string, speakerRole: "self" | "companion", recordingDate: string, segment: string): PreparationSource => ({ id, interactionId, recordingDate, quote, speakerRole, origin: "direct_conversation", valid: true, href: href(interactionId, segment), fingerprint: `fixture-v1:${id}` });

export function makePreviewRecords(other = false): PreviewRecord[] {
  const person = other ? "林舟" : "小夏";
  const photo = other ? "最近想做一只深一点的杯子，还在试杯口的弧度。" : "我最近在准备一个小小的摄影展，还在挑照片。";
  const bird = other ? "上次那只杯子的蓝釉，烧出来比我想的浅一些。" : "海边飞过的那只鸟，我想把它放进那本蓝色的小画册里。";
  const album = other ? "下次我把那块试釉片带给你。" : "下次我把那本相册带给你。";
  return [
    { id: "rec-walk", title: other ? "周日，在陶艺工作室" : "周日，和小夏散步", date: "2026-11-08", fullTranscript: true,
      sources: [source("source-photo", "rec-walk", photo, "companion", "2026-11-08", "seg-photo"), source("source-bird", "rec-walk", bird, "companion", "2026-11-08", "seg-bird"), source("source-quiet", "rec-walk", "有时候一起安静坐一会儿也很好。", "self", "2026-11-08", "seg-quiet")],
      segments: [{ id: "seg-photo", speaker: person, text: photo, time: "13:45" }, { id: "seg-bird", speaker: person, text: bird, time: "14:02" }, { id: "seg-quiet", speaker: "我", text: "有时候一起安静坐一会儿也很好。", time: "40:10" }] },
    { id: "rec-album", title: other ? "一起看试釉片" : "翻一翻旧相册", date: "2026-11-05", fullTranscript: true,
      sources: [source("source-album", "rec-album", album, "self", "2026-11-05", "seg-album")], segments: [{ id: "seg-album", speaker: "我", text: album, time: "08:12" }] },
    { id: "rec-print", title: other ? "第一只杯子的试烧" : "摄影展的小幅试印", date: "2026-11-04", fullTranscript: true,
      sources: [source("source-print", "rec-print", other ? "我们可以把这几块不同温度的试片排在一起看。" : "我们把这几张小幅试印贴满一张纸，就能一起看颜色了。", "companion", "2026-11-04", "seg-print")],
      segments: [{ id: "seg-print", speaker: person, text: other ? "我们可以把这几块不同温度的试片排在一起看。" : "我们把这几张小幅试印贴满一张纸，就能一起看颜色了。", time: "03:20" }] },
  ];
}

function message(id: string, role: "user" | "assistant", text: string, meetingId: string, sources: PreparationSource[] = []): PreparationMessage {
  return { id, role, text, meetingId, sources, createdAt: stamp, kind: "message", origin: role === "user" ? "user_reflection" : "assistant" };
}
function item(id: string, text: string, status: PreparationItem["status"], sourceMessageId: string, meetingId: string, sources: PreparationSource[] = []): PreparationItem {
  return { id, text, status, sourceMessageId, meetingId, sources, createdAt: stamp };
}
function baseDiscussion(records: PreviewRecord[], relationshipId: string, other: boolean): PreparationView {
  const name = other ? "林舟" : "小夏";
  const current = "meeting-next", previous = "meeting-walk";
  const photoSources = records[0].sources.slice(0, 2), albumSources = records[1].sources;
  const items = [
    item("item-album", other ? "带上那块试釉片。一起看看颜色在不同光线里的变化。" : "带上那本相册。把想分享的几页先折个角，见面时慢慢翻。", "selected", "message-album", current, albumSources),
    item("item-space", other ? "问问杯子的进展。聊到时再问杯口的弧度，不急着要一个结果。" : "问问摄影展的进展。聊到时再问那本蓝色小画册，不急着要一个结果。", "selected", "message-space", current, photoSources),
    item("item-candidate", other ? "那只深一点的杯子，杯口的弧度试得怎么样了？" : "那本蓝色小画册，做得怎么样了？", "suggested", "message-current", current, photoSources),
    item("item-travel", "下次见面聊聊旅行。", "selected", "message-previous", previous),
    item("item-withdrawn", "一起去热闹的新展览。", "removed", "message-previous", previous),
  ];
  return { id: "discussion-main", relationshipId, version: 7, title: other ? "下次去陶艺工作室，想留一点从容的时间" : "下次见面，留一点从容的时间", status: "active", currentMeetingId: current,
    interactionIds: records.map(r => r.id), allowRetained: true, reviewLink: null,
    messages: [message("message-previous", "assistant", "可以先留下一个你想自然聊起的话题。", previous), message("message-user-album", "user", other ? "我们约了下次去工作室，我还想带那块试釉片。" : "我们说好下次再见，我想记着带那本相册。", current), message("message-album", "assistant", other ? "先记下带试釉片这件小事。" : "先记下带相册这件小事。", current, albumSources), message("message-user-space", "user", `还想问问${name}最近在做的东西，怎么开口自然一点？`, current), message("message-space", "assistant", "可以从之前聊过的具体小事接着问。", current, photoSources), message("message-user-current", "user", "我想轻松一点，别像在完成任务。", current), message("message-current", "assistant", other ? "那就带上试釉片。杯子的事，聊到时再问也可以。" : "那就带上相册。摄影展的事，聊到时再问也可以。", current)],
    items, events: [
      { id: "event-album", kind: "select", text: items[0].text, createdAt: stamp, ordinal: 0, data: { itemId: "item-album" } },
      { id: "event-space", kind: "select", text: items[1].text, createdAt: stamp, ordinal: 1, data: { itemId: "item-space" } },
      { id: "event-travel", kind: "select", text: items[3].text, createdAt: stamp, ordinal: 2, data: { itemId: "item-travel" } },
      { id: "event-withdrawn", kind: "remove", text: items[4].text, createdAt: stamp, ordinal: 3, data: { itemId: "item-withdrawn", previousStatus: "selected" } },
    ], updatedAt: stamp, createdAt: "2026-11-09T10:00:00+08:00", generationStatus: "idle", intent: "轻松一点地准备下一次见面", date: null, constraints: [] };
}

export function createPreviewFixture(scenario: string, accountId: string, relationshipId: string): PreviewSnapshot {
  const other = scenario === "other-person";
  const records = makePreviewRecords(other);
  if(scenario==='long-sources'){
    const extended=[
      '我最近在准备一个小小的摄影展，还在挑照片。现在还没有决定最后要展出哪些，有几张我很喜欢，但放在一起的顺序还需要试一试。昨天我把几张小幅试印摊在桌上，才发现有些颜色在屏幕上看着很接近，印出来却不一样。我想先留一点时间慢慢看，不急着把名单定下来。也许会把几张放在画册里，展墙上少放一些，让每张照片之间有一点空白。那本画册还只是试着做的，没有确定页数，也没有答应什么时候完成。如果下次见面时还没做完，可以先看几页试样，不一定非要拿出一个完整的东西。',
      '海边飞过的那只鸟，我想把它放进那本蓝色的小画册里。那张照片有一点模糊，可我记得当时我们都停下来望了一会儿，所以还不想把它删掉。我试过把它排在最前面，也试过放在最后一页，每一种位置读起来都不太一样。现在暂时偏向让它跟另一张海面的照片放在一起，但还需要看看实际印出来的颜色。画册的纸也没选定，太白的纸显得有些冷，偏暖一点的也许更合适。这只是目前在试的想法，还没有最后决定。我希望翻起来像那天下午的节奏，不用急着解释每张照片，只要能慢慢看下去就很好。'
    ];
    records[0].sources.slice(0,2).forEach((source,index)=>{source.quote=extended[index];source.fingerprint=`fixture-long-v1:${source.id}`;records[0].segments[index].text=extended[index];});
  }
  const main = baseDiscussion(records, relationshipId, other);
  const old = baseDiscussion(records, relationshipId, other);
  old.id = "discussion-earlier"; old.title = "那天回来，想记下的几句话"; old.currentMeetingId = "meeting-walk"; old.updatedAt = "2026-11-08T20:00:00+08:00"; old.createdAt = old.updatedAt;
  old.messages = [message("earlier-user", "user", "今天散步很舒服，我们聊了旅行。", "meeting-walk"), message("earlier-reply", "assistant", "有什么是你希望下次能自然接上的？", "meeting-walk")]; old.items = [item("earlier-travel", "下次聊聊那条靠海的步道。", "selected", "earlier-reply", "meeting-walk")]; old.events = [];
  const clues: PreviewClue[] = [
    { id: "clue-recent", group: "recent", text: other ? "正在尝试一只更深的杯子。" : "正在为摄影展做一本蓝色的小画册。", sources: records[0].sources.slice(0, 2) },
    { id: "clue-together", group: "together", text: other ? "一起看不同温度烧出的试釉片。" : "一起完成了摄影展的小幅试印。", sources: records[2].sources },
    { id: "clue-promise", group: "promise", text: other ? "下次带上那块试釉片。" : "下次带上那本相册。", sources: records[1].sources },
    { id: "clue-continue", group: "continue", text: other ? "可以问问杯口的弧度试得怎么样了。" : "可以问问蓝色小画册的进展。", reason: "上次的讨论还停留在挑选和尝试的阶段。", sources: records[0].sources.slice(0, 2) },
  ];
  const state: PreviewSnapshot = { schema: 1, accountId, relationshipId, relationshipName: other ? "林舟" : "小夏", relationshipStatus: "established", scenario, discussions: [main, old], availableSources: records, clues, operations: {}, drafts: {}, deletedIds: [], currentDiscussionId: main.id, loading: false, error: null, loggedOut: false, failuresConsumed: [] };
  if (["empty", "no-relationship"].includes(scenario)) { state.discussions = []; state.currentDiscussionId = null; }
  if (scenario === "no-relationship") { state.relationshipStatus = "none"; state.relationshipName = "Ta"; state.availableSources = []; state.clues = []; }
  if (scenario === "unmapped") { state.relationshipStatus = "unmapped"; state.clues = []; main.allowRetained = false; }
  if (scenario === "no-material") { state.availableSources = []; state.clues = []; main.interactionIds = []; main.allowRetained = false; main.items = []; main.messages = [message("user-present", "user", "不知道怎么开头，我想先说说自己的感受。", "meeting-next"), message("assistant-present", "assistant", "可以，从你最在意的那一刻说起就好。", "meeting-next")]; }
  if (["one-candidate", "three-candidates", "no-candidates"].includes(scenario)) {
    main.items = scenario === "no-candidates" ? [] : [main.items[2]];
    main.messages = main.messages.slice(-2);
    if (scenario === "no-candidates") main.messages[1].text = "你希望这次见面有一点从容。可以先把自己的想法说完，不急着决定做什么。";
    if (scenario === "three-candidates") main.items.push(item("candidate-2", "上次挑的那些照片，有没有一张已经决定留下？", "suggested", "message-current", "meeting-next", records[0].sources.slice(0, 1)), item("candidate-3", "那只海边飞过的鸟，后来放进小画册了吗？", "suggested", "message-current", "meeting-next", records[0].sources.slice(1, 2)));
  }
  if (scenario === "removed") { main.items[2].status = "removed"; main.events.push({ id: "never-selected", kind: "remove", text: "", createdAt: stamp, ordinal: 4, data: { itemId: "item-candidate", previousStatus: "suggested" } }); }
  if (scenario === "paused") main.status = "paused";
  if (scenario === "bottom-edit") main.items[2].status = "selected";
  if (scenario === "linked") main.reviewLink = { id: "link-walk", interactionId: "rec-walk", recordingDate: "2026-11-08", linkedAt: stamp, available: true, originalMeetingId: "meeting-walk", nextMeetingId: "meeting-next", originalItemIds: ["item-travel"] };
  if (scenario === "fragment-only") for (const record of records) record.fullTranscript = false;
  if (scenario === "invalid-source") { records[0].sources.forEach(s => { s.valid = false; s.quote = ""; s.href = ""; }); records[0].segments = []; records[0].fullTranscript = false; }
  if (scenario === "feedback") { main.messages.push({ ...message("feedback-user", "user", "我觉得 Ta 今天有点累，下次只想安静地陪一会儿。给我一个建议就好。", "meeting-next"), kind: "feedback" }, message("feedback-assistant", "assistant", "", "meeting-next", [records[0].sources[2]])); main.items = [main.items[3], item("feedback-option", "见面时先问，要不要一起找个地方坐坐。", "suggested", "feedback-assistant", "meeting-next", [records[0].sources[2]])]; main.events.push({ id: "feedback-boundary", kind: "feedback_boundary", text: "本次反馈对应新的见面背景", createdAt: stamp, ordinal: main.events.length, data: { originalMeetingId: "meeting-walk", nextMeetingId: "meeting-next" } }); }
  if (scenario === "long") {
    main.title = "下次见面，想留一点从容的时间，也想聊聊那些还没说完的小事，不急着安排一个很满的下午";
    main.items[0].text = "下次带上那本相册，不过先问问 Ta 那天是否方便慢慢翻；如果还有别的安排，就留到之后，不一定要在这次看完。";
    for (let i = 0; i < 7; i++) main.items.push(item(`long-selected-${i}`, ["见面前确认一下时间是否仍然合适。", "给路上留一点余地，不急着赶到下一个地方。", "想起一个有趣的小细节时，再顺着当下的话题聊。", "如果当天想法变了，就直接说，不把准备当作必须完成的事。"][i % 4], "selected", "message-space", "meeting-next"));
    for (let i = 0; i < 14; i++) main.messages.splice(main.messages.length - 2, 0, message(`long-message-${i}`, i % 2 ? "assistant" : "user", i % 2 ? "可以把准备留得轻一点。它是你的想法，不是需要全部完成的清单；到时候仍然可以听听彼此想怎么过。" : "我想慢慢说清楚，又不想让每句话听起来都像提前安排过。也许只是记住一个小细节，其他的到了那时再决定。", "meeting-next"));
  }
  if (["normal", "selected-edit", "long", "long-reply", "long-sources", "history", "other-person", "delete", "paused", "meetings", "scope", "linked", "sources", "fragment-only", "read-failure", "slow", "reply-failure", "unknown-result", "conflict", "late", "unmapped"].includes(scenario)) main.items = main.items.filter(i => i.id !== "item-candidate");
  return state;
}
