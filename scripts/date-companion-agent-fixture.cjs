// Model transport only. Production API, business service, SQLite and AgentRuntime run unchanged.
const fs=require('node:fs'),path=require('node:path');
const original=globalThis.fetch.bind(globalThis);let calls=0;
function p2Action(payload, respond) {
 const {goal,results,observation}=payload;
 if(goal.includes('会前给我一个小准备')) {
  return {tool:'respond',args:{reply:'',suggestions:['见面时可以问问 Ta 最近有没有想去旅行的地方。'],sourceIds:[],date:'2026-11-06',constraints:['下午']}};
 }
 if(goal.includes('我想对照这份记录')) {
  const located=results.find(r=>r.tool==='list_review_sources');
  const verified=results.find(r=>r.tool==='read_source');
  if(!located)return {tool:'list_review_sources',args:{}};
  if(!located.value.sources?.[0]?.id)throw Error('Expected an authorized linked locator from the business tool');
  if(!verified)return {tool:'read_source',args:{sourceId:located.value.sources[0].id}};
  const source=verified.value.sources?.[0];
  if(!source?.quote||source.speakerRole!=='companion')throw Error('Expected a current verified companion quote');
  return respond(`在 ${source.recordingDate} 的这份记录里，Ta 说：“${source.quote}”这段能核对的是散步的话题。你当时觉得 Ta 工作有点累，这是你的理解。记录里没有提到旅行，仅凭这一段还不能判断当时有没有聊过。`,[],[source.id]);
 }
 if(goal.includes('接着准备下一次')) {
  return respond('', ['下次见面可以先问：“今天想走走，还是坐一会儿？”']);
 }
 if(goal.includes('纠正一下')) return respond('明白，你想说的是自己当时有点紧张。');
 if(goal.includes('回头理一理我自己的想法')) {
  const offsets=results.filter(r=>r.tool==='read_progress').length;
  if(offsets<2)return {tool:'read_progress',args:{offset:offsets*8}};
  return respond('你现在更想弄清的是自己当时的紧张感，可以先从这个感觉说起。');
 }
 if(goal.includes('现在还是想说说我的紧张')) {
  if(!JSON.stringify(observation).includes('自己当时有点紧张'))throw Error('Effective user correction missing from model observation');
  return respond('你后来发现自己当时有点紧张。那个感觉最明显的是哪一刻？');
 }
 if(goal.includes('只想聊聊')||goal.includes('没有可用录音')) return respond('你可以先说说，是什么让你当时有点拿不准？');
 throw Error('Unexpected P2 synthetic conversation turn');
}
async function p3Action(payload, respond) {
 const {goal,results,observation}=payload;
 if (goal.includes('最初留下的那条')) {
  const history=results.find(result => result.tool==='read_progress');
  if (!history) return {tool:'read_progress',args:{offset:0}};
  const first=history.value.events.find(event => event.kind==='select');
  if (!first?.text?.includes('旅行') || !JSON.stringify(observation.latestFeedback).includes('附近走走'))
   throw Error('Expected an actual early selection and the latest user reflection');
  const detail=history.value.events.find(event=>event.kind==='message' && event.text.includes('旧车票'));
  if(!detail) throw Error('Expected earlier user context on the returned page');
  return respond(`你那时留下的是“${first.text}”你还提到，是看见旧车票才想起这个话题。`);
 }
 if(goal.includes('结合最近的感受')) {
  if(!JSON.stringify(observation.latestCorrection).includes('自己当时有点紧张') ||
     !JSON.stringify(observation.latestFeedback).includes('附近走走')) throw Error('Expected latest correction and feedback');
  return respond('', ['见面时问问 Ta，想不想在附近走一小段。']);
 }
 if (goal.includes('我改主意了')) {
  if(!observation.items.some(item=>item.choiceState==='withdrawn')) throw Error('Expected the withdrawn choice in business history');
  return respond('这条已经放下了。你更想聊聊现在的感受吗？');
 }
 if (goal.includes('再慢慢说')) {
  const located=results.find(result=>result.tool==='list_review_sources');
  if(!located) return {tool:'list_review_sources',args:{}};
  const source=results.find(result=>result.tool==='read_source');
  if(!source) return {tool:'read_source',args:{sourceId:located.value.sources[0].id}};
  if(!source.value.sources[0]?.quote) throw Error('The delayed decision must have received the previous source');
  const marker=path.join(process.env.DATE_AGENT_ARTIFACTS,'delayed-'+payload.authorizedScope.preparationId);
  fs.writeFileSync(marker+'.started',payload.authorizedScope.generationId);
  for(let n=0;!fs.existsSync(marker+'.release');n++) {
   if(n>=700) throw Error('Timed out waiting for the controlled local release');
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  return respond('本应丢弃的晚到回答。',['本应丢弃的晚到准备。']);
 }
 if (goal.includes('继续聊之前的紧张')) {
  const pages=results.filter(result=>result.tool==='read_progress').length;
  if (pages<2) return {tool:'read_progress',args:{offset:pages*8}};
  return respond('你提到紧张的是自己。现在再想起来，最在意哪一刻？');
 }
 if (goal.includes('暂时没有新的进展')) return respond('可以先放在这里，等你想说时再聊。');
 return p2Action(payload,respond);
}
globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 if(url!=='https://tokenhub.vision-intelligence.tech/v1/responses')return original(input,init);
 if(process.env.OPENAI_API_KEY!=='offline-date-agent-key'||!process.env.DATE_AGENT_ARTIFACTS)throw Error('Fixture requires isolated runner');
 const request=new Request(input,init),body=await request.json();
 const payload=JSON.parse(body.input.find(m=>m.role==='user').content);
 if(!payload.observation||!payload.authorizedScope?.preparationId)throw Error('Unexpected model path');
 const goal=payload.goal,observation=payload.observation,results=payload.results;
 const respond=(reply,suggestions=[],sourceIds=[])=>({tool:'respond',args:{reply,suggestions,sourceIds}});
 let action;
 if(process.env.DATE_AGENT_FIXTURE_PHASE==='p3')action=await p3Action(payload,respond);
 else if(process.env.DATE_AGENT_FIXTURE_PHASE==='p2')action=p2Action(payload,respond);
 else if(/撤回旧资料/.test(goal))action=respond('按你现在的想法，这次就安静一点。旧资料已撤回，我们只从你当前的表达继续。');
 else if(/工作很累|安静散步/.test(goal)){
  if(process.env.DATE_AGENT_REPLAY_FEEDBACK){
   // Reuse the exact completed, synthetic-account response at the transport
   // boundary. Never open its ledger or send the request a second time.
   const sample=JSON.parse(fs.readFileSync(process.env.DATE_AGENT_REPLAY_FEEDBACK,'utf8'));
   if(sample.state!=='completed'||sample.model!==body.model)throw Error('Expected a completed Date Companion sample');
   action=JSON.parse(sample.finalAssistantText);
  }else action=respond('你当时觉得 Ta 有些累，也记得那段安静陪伴。',['下次见面时问问 Ta：“现在想聊聊，还是一起安静走一会儿？”']);
 }
 else if(/只讨论|只想聊聊|不做准备/.test(goal))action=respond('可以，我们只聊聊，不急着安排什么。你担心提起那件事后会发生什么？可以从最在意的部分慢慢说。');
 else if(/旅行/.test(goal)&&observation.historyAllowed){
  const searched=results.find(r=>r.tool==='search_records');
  const read=results.find(r=>r.tool==='read_source');
  if(!searched)action={tool:'search_records',args:{query:'旅行'}};
  else if(!read&&searched.value.sources[0])action={tool:'read_source',args:{sourceId:searched.value.sources[0].id}};
  else if(read?.value.sources[0]){const source=read.value.sources[0];action=respond('上次确实聊过旅行。Ta 在'+source.recordingDate+'的记录里说：“'+source.quote+'”',['如果聊得自然，可以问问 Ta 最近还想不想去海边。'],[source.id]);}
  else action=respond('这次没找到相关原话，仍可以从你希望轻松一点的想法聊起。');
 }else action=respond('可以从你现在最在意的地方聊起。你希望明天的相处有什么不同？');
 calls++;
 // Only this explicit synthetic fixture logs its payload to its isolated evidence directory.
 fs.appendFileSync(path.join(process.env.DATE_AGENT_ARTIFACTS,'fixture-inputs.jsonl'),JSON.stringify({index:calls,payload,
   ...(['p2','p3'].includes(process.env.DATE_AGENT_FIXTURE_PHASE)?{requestId:request.headers.get('x-client-request-id'),inputMessages:body.input}:{})})+'\n');
 fs.appendFileSync(path.join(process.env.DATE_AGENT_ARTIFACTS,'synthetic-calls.jsonl'),JSON.stringify({index:calls,model:body.model,action:action.tool,kind:'synthetic_transport',retry:request.headers.get('x-stainless-retry-count')})+'\n');
 const event={type:'response.completed',response:{id:`offline-date-${calls}`,status:'completed',error:null,incomplete_details:null,usage:{input_tokens:100,output_tokens:50},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(action)}]}]}};
 return new Response(`data: ${JSON.stringify(event)}\n\n`,{headers:{'content-type':'text/event-stream','x-request-id':`offline-date-${calls}`}});
};
