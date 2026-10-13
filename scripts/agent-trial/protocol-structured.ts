import OpenAI from 'openai';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStructuredJsonResponse, type StructuredJsonDiagnostics } from '../../src/lib/server/openai/structured-json';
const root = process.env.AGENT_TRIAL_DIR!;
if (!process.argv.includes('--real') || !(globalThis as unknown as Record<string, unknown>).__DAILY_BRIEF_AGENT_TRIAL_GUARD__) throw Error('explicit_real_mode_and_budget_guard_required');
process.env.AGENT_TRIAL_PHASE = 'protocol';
const client = new OpenAI({ apiKey:process.env.DAILY_BRIEF_OPENAI_API_KEY!, baseURL:'https://tokenhub.vision-intelligence.tech/v1',
  timeout:120000,maxRetries:0,logLevel:'off',organization:null,project:null });
const schema=z.object({tool:z.enum(['read_scope','request_material']),args:z.record(z.unknown())}).strict();
const prompt='You are a restricted learning agent. Return JSON {"tool":"read_scope|request_material","args":{}} selecting one action. read_scope reads the authorized course inventory; request_material asks the user to provide material and args must have message. First inspect the actual course; when its real result is provided, use it to select the next action. Never invent materials.';
const report:{protocol:string;calls:StructuredJsonDiagnostics[];actions:unknown[];passed:boolean;failure?:string}={protocol:'structured_action_v1',calls:[],actions:[],passed:false};
async function decide(input:unknown){return parseStructuredJsonResponse({client,model:'deepseek-v4-pro',name:'agent_protocol',schema,
  mode:'json',stream:true,store:false,jsonInstruction:'Return the single restricted action JSON.',maxOutputTokens:1500,maxResponseBytes:200000,
  reasoning:{effort:'none'} as never,requestInput:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],
  requestOptions:{maxRetries:0,timeout:120000,signal:AbortSignal.timeout(120000)},onDiagnostics:d=>report.calls.push(d)});}
try{
  const first=await decide({goal:'Help me review this current course.'});report.actions.push(first);
  if(first.tool!=='read_scope')throw Error('read_action_not_selected');
  const result=JSON.parse(readFileSync(join(root,'protocol-course.json'),'utf8'));
  const next=await decide({goal:'Help me review this current course.',previousAction:first,actualToolResult:result});report.actions.push(next);
  if(next.tool!=='request_material'||typeof next.args.message!=='string')throw Error('result_did_not_change_action');
  report.passed=true;
}catch(e){report.failure=e instanceof Error&&/^[a-z_]+$/.test(e.message)?e.message:'structured_protocol_failed';}
writeFileSync(join(root,'protocol-structured.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
