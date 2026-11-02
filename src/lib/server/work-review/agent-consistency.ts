import type {WorkAgentChange, WorkAgentChangeReview, WorkAgentContext, WorkAgentSource} from "@/lib/domain/work-agent";

// A narrow, deterministic backstop for this product's operations, NOT an entailment
// verifier. Only canonical clauses support actions; labels never authorize payloads.
// Unknown wording stays needs_review, and the user must still confirm allowed items.
const segmenter = new Intl.Segmenter("zh", {granularity:"word"});
const generic = new Set(["方案","任务","事项","工作","问题","测试","完成","调整","等待","回复","确认","原","的"]);
const clauses = (s:WorkAgentSource) => s.evidence.flatMap(e=>e.text.match(/[^。；;！？!?，,\n]+[！？!?]?/gu)??[]).map(s=>s.trim()).filter(Boolean);
const compact = (s:string) => s.normalize("NFKC").toLowerCase().replace(/[\s“”「」『』"']/gu,"");
function subjectWords(title:string) {
  // ICU can split domain words into individual Han characters (e.g. two-character
  // technical verbs). Keep adjacent single-character runs as an identity token.
  const parts=[...segmenter.segment(title)].filter(s=>s.isWordLike).map(s=>s.segment),words:string[]=[];
  for(let i=0;i<parts.length;i++){
    let word=parts[i];
    if(/^\p{Script=Han}$/u.test(word))while(i+1<parts.length&&/^\p{Script=Han}$/u.test(parts[i+1]))word+=parts[++i];
    if(word.length>=2)words.push(word);
    else if(/^\p{Script=Han}$/u.test(word)&&words.length)words[words.length-1]+=word;
  }
  const specific=words.filter(w=>!generic.has(w));
  return specific.length?specific:words.filter(w=>!["任务","工作","事项","问题"].includes(w));
}
function sameSubject(clause:string,title:string) {
  return subjectWords(title).some(word=>compact(clause).includes(compact(word)));
}
const negative = /(?:还没|尚未|仍未|没有|未曾|未|不能|无法|不再|不)(?:[^，。；！？]{0,12})$/u;
const qualified = /(?:如果|若|一旦|假如|是否|可能|计划|预计|准备|待确认|待核实|不能认定|不代表|不能说)/u;
const historical = /(?:此前|之前|原先|上次|当时|曾经)/u;
const predicates = {
  complete:/完成|通过|解决|回复|答复|交付|收到/gu,
  resolves:/解决|关闭/gu,
  supersedes:/替代|取代|替换|改用|改为|改成|调整为|切换到|切换为|更换为/gu,
  suspends:/暂停|暂缓|中止/gu,
  withdraws:/撤回|撤销|取消|废止/gu,
};
type Predicate = keyof typeof predicates;
function polarity(clause:string,kind:Predicate):"positive"|"negative"|"uncertain"|null {
  const matches=[...clause.matchAll(predicates[kind])];
  if(!matches.length)return null;
  if(historical.test(clause))return "uncertain";
  if(qualified.test(clause)||/[？?]|[吗么](?:[？?！!])?$/u.test(clause))return "uncertain";
  if(matches.some(m=>negative.test(clause.slice(0,m.index))))return "negative";
  if(kind!=="complete"&&kind!=="resolves")return "positive";
  return matches.some(m=>/(?:已(?:经|全部)?|全部|确认)[^，。；！？]{0,12}$/u.test(clause.slice(0,m.index))
    || /^了/u.test(clause.slice(m.index!+m[0].length)))?"positive":"uncertain";
}
function verdict(status:WorkAgentChangeReview["status"],reason:string,sourceFindingIds:string[]=[]):WorkAgentChangeReview {
  return {status,reason,sourceFindingIds:[...new Set(sourceFindingIds)]};
}
const confirmable = () => verdict("confirmable","未发现本次规则可识别的明确矛盾；仍需逐项核对原文并确认。");
const unsure = (reason:string,ids:string[]=[]) => verdict("needs_review",`${reason}请调整建议或核实依据后重新比较；本项不能批准。`,ids);
const blocked = (reason:string,ids:string[]) => verdict("blocked",`${reason}本项已阻止，不能批准。`,ids);

function checkOutcome(context:WorkAgentContext,change:WorkAgentChange,target:string,kind:Predicate,support:WorkAgentSource[]) {
  const current=context.sources.filter(s=>s.meetingId===context.meetingId);
  // Do not treat an old unresolved statement as a contradiction to a new resolution.
  // Same-meeting contradictory clauses have no reliable order: do not silently choose one.
  const opposition=current.filter(s=>clauses(s).some(c=>sameSubject(c,target)&&polarity(c,kind)==="negative"));
  if(opposition.length)return blocked("本次会议原文对目标事项有明确反证，与完成或关闭操作矛盾。",opposition.map(s=>s.findingId));
  const relevant=support.flatMap(s=>clauses(s).filter(c=>sameSubject(c,target)).map(c=>({s,c})));
  if(relevant.some(({c})=>polarity(c,kind)==="positive"))return confirmable();
  return unsure("引用原文未能明确支持目标事项的完成或解决；缺少记录不代表已完成。",change.sourceFindingIds);
}

// Recognize literal replacement values, not particular project/plan names. When
// a value cannot be extracted or matched, do not invent the intended new title.
function replacementValue(clause:string) {
  const match=clause.match(/(?:调整为|改为|改成|改用|切换到|切换为|更换为|替换为)([^，。；！？]{1,40})/u);
  if(!match)return null;
  return match[1].replace(/^(?:使用|采用)/u,"").replace(/(?:的)?(?:方案|配置|版本|部署|上线|流程|设置).*$/u,"").trim()||null;
}
function hasValue(text:string,value:string) {
  const normalized=compact(value),actual=compact(text);
  if(/^[a-z0-9_.-]+$/u.test(normalized)){
    const tokens:string[]=actual.match(/[a-z0-9_.-]+/gu)??[];
    return tokens.includes(normalized);
  }
  return actual.includes(normalized);
}
function checkUpdate(context:WorkAgentContext,change:Extract<WorkAgentChange,{kind:"update_todo"}>,support:WorkAgentSource[]) {
  const todo=context.todos.find(t=>t.id===change.todoId)!;
  const related=support.flatMap(s=>clauses(s).filter(c=>sameSubject(c,todo.title)).map(c=>({s,c})));
  if(!related.length)return unsure("尚不能把修改内容对应到该待办的直接依据。",change.sourceFindingIds);
  const instructions=related.filter(({c})=>/(?:调整为|改为|改成|改用|切换到|切换为|更换为|替换为)/u.test(c));
  if(instructions.some(({c})=>polarity(c,"supersedes")==="negative"||/(?:不要|不得|不能).*(?:调整|切换|更换|替换)/u.test(c)))
    return blocked("引用原文明确反对这项内容更新。",change.sourceFindingIds);
  const contentInstructions=instructions.filter(({c})=>{
    const index=c.search(/调整为|改为|改成|改用|切换到|切换为|更换为|替换为/u);
    return !/(?:负责人|责任人|期限|截止(?:日期|时间)?|日期|时间)\s*$/u.test(c.slice(0,index));
  });
  if(instructions.some(({c})=>qualified.test(c)))return unsure("内容更新仍带有条件或不确定性。",change.sourceFindingIds);
  if(contentInstructions.length){
    if(compact(change.title)===compact(todo.title))return blocked("原文要求改变待办内容，但实际新内容仍与旧内容相同；修改显示标签或期限不能代替内容调整。",change.sourceFindingIds);
    const values=contentInstructions.map(({c})=>replacementValue(c));
    if(values.some(v=>!v)||new Set(values.map(v=>compact(v!))).size!==1)return unsure("原文的新内容尚不能唯一确定。",change.sourceFindingIds);
    if(!hasValue(change.title,values[0]!))return blocked("实际待办内容未包含原文明确要求的新内容，与修改依据不一致。",change.sourceFindingIds);
    const prefix=compact(change.title).slice(0,compact(change.title).indexOf(compact(values[0]!)));
    if(negative.test(prefix))return blocked("实际待办内容否定了原文明确要求的新内容。",change.sourceFindingIds);
    if(qualified.test(change.title)||/考虑|候选|备选/u.test(change.title))return unsure("实际新内容仍表述为候选或条件，与明确的内容调整不能直接对应。",change.sourceFindingIds);
  }else if(compact(change.title)!==compact(todo.title)){
    const added=subjectWords(change.title).filter(w=>!compact(todo.title).includes(compact(w)));
    if(!added.length||added.some(w=>!related.some(({c})=>compact(c).includes(compact(w)))))
      return unsure("实际新内容不能由目标事项的引用原文直接核对。",change.sourceFindingIds);
  }
  // Check changed literal owner/deadline fields too; unchanged user fields retain
  // their authority. This is not an inference of a new owner or a relative date.
  if(change.ownerLabel!==todo.ownerLabel && (!change.ownerLabel||!related.some(({c})=>c.includes(change.ownerLabel!))))
    return unsure("修改后的负责人缺少可直接核对的依据。",change.sourceFindingIds);
  if(change.dueDate!==todo.currentDueDate){
    if(!change.dueDate)return unsure("清除期限缺少可直接核对的依据。",change.sourceFindingIds);
    const [year,month,day]=change.dueDate.split("-").map(Number);
    if(!related.some(({s})=>clauses(s).some(c=>c.includes(change.dueDate!)
      || ((c.includes(`${year}年`)||s.meetingDate.startsWith(`${year}-`))&&c.includes(`${month}月${day}日`)))))
      return unsure("修改后的期限与引用日期不能直接对应。",change.sourceFindingIds);
  }
  return confirmable();
}

export function reviewWorkAgentChange(context:WorkAgentContext,change:WorkAgentChange):WorkAgentChangeReview {
  const support=change.sourceFindingIds.map(id=>context.sources.find(s=>s.findingId===id)).filter((s):s is WorkAgentSource=>!!s);
  if(support.length!==change.sourceFindingIds.length)return blocked("操作依据不在本次有效来源范围。",change.sourceFindingIds);
  if(change.kind==="complete_todo"){
    const todo=context.todos.find(t=>t.id===change.todoId);
    if(!todo)return blocked("目标待办不在本次项目范围。",change.sourceFindingIds);
    return checkOutcome(context,change,todo.title,"complete",support.filter(s=>s.meetingId===context.meetingId));
  }
  if(change.kind==="update_todo"){
    if(!context.todos.some(t=>t.id===change.todoId))return blocked("目标待办不在本次项目范围。",change.sourceFindingIds);
    return checkUpdate(context,change,support.filter(s=>s.meetingId===context.meetingId));
  }
  if(change.kind==="relation"){
    const anchor=context.sources.find(s=>s.findingId===change.anchorFindingId),fact=context.sources.find(s=>s.findingId===change.findingId);
    if(!anchor||!fact)return blocked("关系缺少有效依据。",change.sourceFindingIds);
    if(change.relation==="resolves")return checkOutcome(context,change,anchor.title,"resolves",[fact]);
    if(["supersedes","suspends","withdraws"].includes(change.relation)){
      const kind=change.relation as "supersedes"|"suspends"|"withdraws";
      const signs=clauses(fact).map(c=>polarity(c,kind));
      if(signs.includes("negative"))return blocked("关系依据明确否定这项决定变化，不能凭正式决定类型推断替代、暂停或撤回。",[fact.findingId]);
      if(!signs.includes("positive"))return unsure("原文未明确支持这项决定变化。",[fact.findingId]);
    }
  }
  return confirmable();
}
