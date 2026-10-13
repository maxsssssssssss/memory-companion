import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.AGENT_TRIAL_DIR;
if (!process.argv.includes('--real') || !globalThis.__DAILY_BRIEF_AGENT_TRIAL_GUARD__) throw Error('explicit_real_mode_and_budget_guard_required');
process.env.AGENT_TRIAL_PHASE = 'protocol';
const client = new OpenAI({ apiKey: process.env.DAILY_BRIEF_OPENAI_API_KEY,
  baseURL: 'https://tokenhub.vision-intelligence.tech/v1', maxRetries: 0, timeout: 120000,
  logLevel: 'off', organization: null, project: null });
const tools = [{ type:'function', name:'read_scope', description:'Read the actual authorized synthetic course inventory.',
  parameters:{ type:'object', properties:{}, required:[], additionalProperties:false }, strict:true },
  { type:'function', name:'request_material', description:'Ask user to add material when the authorized course has none.',
    parameters:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false},strict:true }];
const base = { model:'deepseek-v4-pro', max_output_tokens:1500, store:false, stream:true,
  reasoning:{effort:'none'} };
const input = [{role:'system',content:'You are testing a restricted learning agent protocol. Choose exactly one available tool per turn. First inspect the actual authorized course. On receiving its real tool result, choose the next appropriate action. Do not invent materials.'},
  {role:'user',content:'Help me review this current course.'}];
async function call(body) {
  const response = await client.responses.create({...base,...body}).asResponse(); let completed;
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  while(true){const r=await reader.read();if(r.done)break;buffer+=decoder.decode(r.value,{stream:true});let at;
    while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(!line.startsWith('data:'))continue;
      const raw=line.slice(5).trim();if(!raw||raw==='[DONE]')continue;const event=JSON.parse(raw);
      if(event.type==='response.completed')completed=event.response;
      if(event.type==='error'||event.type==='response.failed')throw Error('native_stream_error_'+String(event.code??event.response?.error?.code??'unknown').replace(/[^a-z_]/gi,''));
    }
  }
  if(!completed)throw Error('missing_completed_event'); return completed;
}
const report = { protocol:'native_responses_tools', calls:[], passed:false };
try {
  const first=await call({input,tools,tool_choice:'auto',parallel_tool_calls:false});
  report.calls.push({status:first.status,usage:first.usage,outputTypes:first.output.map(x=>x.type)});
  const selected=first.output.filter(x=>x.type==='function_call');
  if(selected.length!==1||selected[0].name!=='read_scope')throw Error('native_read_action_not_selected');
  // Actual local inventory read: this isolated course deliberately has no materials.
  const inventoryPath=path.join(root,'protocol-course.json');
  if(!fs.existsSync(inventoryPath))fs.writeFileSync(inventoryPath,JSON.stringify({materials:[]}));
  const observed=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
  const second=await call({input:[...input,...first.output,{type:'function_call_output',call_id:selected[0].call_id,output:JSON.stringify(observed)}],tools,tool_choice:'auto',parallel_tool_calls:false});
  report.calls.push({status:second.status,usage:second.usage,outputTypes:second.output.map(x=>x.type)});
  const action=second.output.filter(x=>x.type==='function_call');
  report.passed=action.length===1&&action[0].name==='request_material';
  report.secondAction=action.map(x=>({name:x.name,arguments:JSON.parse(x.arguments)}));
  if(!report.passed)throw Error('native_result_did_not_drive_next_action');
} catch(error) { report.failure={name:error.name,status:error.status??null,code:/^[a-z_]+$/.test(error.message)?error.message:'provider_protocol_rejected'}; }
fs.writeFileSync(path.join(root,'protocol-native.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
process.exitCode=report.passed?0:1;
