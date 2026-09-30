import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import path from 'node:path';
import {learningAudioGateway} from './audio-gateway.mjs';
import {localEnvironment,localDataDirectory,cleanupLocalOcr,stopConfiguredOcr} from './runtime.mjs';
test('local runtime honors the configured account store and preserves product config',()=>{
  const env=localEnvironment({APP_DATA_DIR:'./synthetic-account-store',DATA_DIR:'./synthetic-other-store',OPENAI_API_KEY:'SYNTHETIC_ONLY',WORK_REVIEW_MODEL:'keep-original',DAILY_REFLECTION_UPLOAD_ENABLED:'true',SPEAKER_ASR_AUDIO_BASE_URL:'https://other-product.synthetic.invalid'},
    {invite:'SYNTHETIC',secret:'SYNTHETIC_LEARNING_SEPARATE_SECRET'},'https://learning.synthetic.invalid','SYNTHETIC_OCR');
  assert.equal(env.APP_STORAGE_MODE,'local');assert.equal(env.PIPELINE_EXECUTION_MODE,'inline');
  assert.equal(env.APP_DATA_DIR,path.resolve('synthetic-account-store'));assert.equal(env.DATA_DIR,env.APP_DATA_DIR);assert.equal(env.WORK_REVIEW_MODEL,'keep-original');
  assert.equal(env.DAILY_REFLECTION_UPLOAD_ENABLED,'true');assert.equal(env.LEARNING_AI_PROVIDER,'tokenhub');
  assert.equal(env.SPEAKER_ASR_AUDIO_BASE_URL,'https://other-product.synthetic.invalid');assert.equal(env.LEARNING_ASR_AUDIO_BASE_URL,'https://learning.synthetic.invalid');
  assert(!env.NODE_OPTIONS.includes('guard'));assert.equal(env.LEARNING_PDF_SERVICE_TOKEN,'SYNTHETIC_OCR');
});
test('data selection follows app storage precedence and defaults to the normal local store',()=>{
  assert.equal(localDataDirectory({APP_DATA_DIR:' ./synthetic-primary ',DATA_DIR:'./synthetic-secondary'}),path.resolve('synthetic-primary'));
  assert.equal(localDataDirectory({APP_DATA_DIR:'  ',DATA_DIR:' ./synthetic-secondary '}),path.resolve('synthetic-secondary'));
  assert.equal(localDataDirectory({APP_DATA_DIR:'',DATA_DIR:' '}),path.resolve('.data'));
  assert.equal(localDataDirectory({}),path.resolve('.data'));
});
test('local learning uses the adopted larger input window without changing output, timeout or other product budgets',()=>{
  const cfg={APP_DATA_DIR:'.data',LEARNING_AI_MAX_INPUT_CHARS:'48000',WORK_REVIEW_MODEL:'keep-original',
    WORK_REVIEW_MAX_INPUT_CHARS:'12345',OPENAI_MAX_OUTPUT_TOKENS:'4321'};
  const env=localEnvironment(cfg,{invite:'SYNTHETIC',secret:'SYNTHETIC_LEARNING_SEPARATE_SECRET'},'https://learning.synthetic.invalid');
  assert.equal(env.LEARNING_AI_MAX_INPUT_CHARS,'120000');
  assert.equal(env.LEARNING_AI_MAX_OUTPUT_TOKENS,'16000');
  assert.equal(env.LEARNING_AI_REQUEST_TIMEOUT_MS,'240000');
  assert.equal(env.LEARNING_AI_PROVIDER,'tokenhub');assert.equal(env.LEARNING_AI_MODEL,'deepseek-v4-pro');
  assert.equal(env.WORK_REVIEW_MODEL,cfg.WORK_REVIEW_MODEL);
  assert.equal(env.WORK_REVIEW_MAX_INPUT_CHARS,cfg.WORK_REVIEW_MAX_INPUT_CHARS);
  assert.equal(env.OPENAI_MAX_OUTPUT_TOKENS,cfg.OPENAI_MAX_OUTPUT_TOKENS);
  assert.equal(cfg.LEARNING_AI_MAX_INPUT_CHARS,'48000');
});
test('trial account store requires the explicit trial option; configured store is not merged or rewritten',()=>{
  const cfg={APP_DATA_DIR:'.data',DATA_DIR:'./synthetic-unused'},secure={invite:'SYNTHETIC',secret:'SYNTHETIC_LEARNING_SEPARATE_SECRET'};
  const trial=localEnvironment(cfg,secure,'https://learning.synthetic.invalid',undefined,true);
  assert.equal(trial.APP_DATA_DIR,path.resolve('output/learning-input-scope-20260924/data'));
  assert.equal(trial.DATA_DIR,trial.APP_DATA_DIR);assert.equal(cfg.APP_DATA_DIR,'.data');
  assert.equal(localEnvironment(cfg,secure,'https://learning.synthetic.invalid').APP_DATA_DIR,path.resolve('.data'));
});
test('audio gateway blocks other paths, wrong/expired signatures and forwards only bound short-lived routes',async()=>{
  const events=[],secret='SYNTHETIC_NOT_A_REAL_SECRET';let hits=0;
  const upstream=http.createServer((q,r)=>{hits++;r.writeHead(200,{'content-type':'audio/wav','content-length':'3'});r.end('abc');});
  const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r('http://127.0.0.1:'+s.address().port)));
  const target=await listen(upstream),gateway=learningAudioGateway({base:target,secret,event:e=>events.push(e)}),base=await listen(gateway);
  const id='12345678-1234-4234-a234-123456789abc',pathname=`/api/learning/asr-audio/synthetic/${id}/${id}/${id}/0`;
  const signed=expires=>{const capability=createHmac('sha256',secret).update(['v1','transcription','synthetic',`learning:${id}:${id}:${id}`,'0',String(expires)].join('\0')).digest('base64url');return base+pathname+'?'+new URLSearchParams({purpose:'transcription',expires:String(expires),capability});};
  try {
    assert.equal((await fetch(base+'/api/auth/login')).status,404);assert.equal((await fetch(base+pathname)).status,401);
    assert.equal((await fetch(signed(Math.floor(Date.now()/1000)-1))).status,401);
    assert.equal((await fetch(signed(Math.floor(Date.now()/1000)+301))).status,401);assert.equal(hits,0);
    const response=await fetch(signed(Math.floor(Date.now()/1000)+120));assert.equal(await response.text(),'abc');assert.equal(hits,1);
    assert(response.headers.get('cache-control').includes('no-store'));assert.equal(events.at(-1).bytes,3);
    assert(!JSON.stringify(events).includes('capability='));assert(!JSON.stringify(events).includes(secret));
  } finally {for(const s of[gateway,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
});

test('OCR instance identity is injected only from the selected live startup',()=>{
  const cfg={APP_DATA_DIR:'.data',LEARNING_PDF_SERVICE_EPOCH:'stale',LEARNING_PDF_SERVICE_INSTANCE:'session-999'};
  const secure={invite:'SYNTHETIC',secret:'SYNTHETIC_SECRET'};
  const identity={epoch:'a'.repeat(64),instance:'session-2'};
  const active=localEnvironment(cfg,secure,'','SYNTHETIC_OCR',false,identity);
  assert.equal(active.LEARNING_PDF_SERVICE_EPOCH,identity.epoch);
  assert.equal(active.LEARNING_PDF_SERVICE_INSTANCE,'session-2');
  assert.equal(localEnvironment(cfg,secure,'').LEARNING_PDF_SERVICE_EPOCH,'');
  assert.equal(localEnvironment(cfg,secure,'','SYNTHETIC_OCR').LEARNING_PDF_SERVICE_INSTANCE,'');
});


test('local app cleanup detaches a ready persistent OCR but retains finite-trial cleanup',()=>{
  let stops=0;const records=[],record=(...args)=>records.push(args),stop=()=>{stops++;};
  cleanupLocalOcr({persistent:true,binding:{instance:'session-3'},stop},record);
  assert.equal(stops,0);assert.equal(records[0][0],'ocr-preserved.json');
  cleanupLocalOcr({persistent:false,stop},record);assert.equal(stops,1);
  cleanupLocalOcr(undefined,record);assert.equal(stops,1);
  cleanupLocalOcr({persistent:false,stop},record,{explicitStop:true});assert.equal(stops,1);
});
test('explicit OCR stop requires the persisted exact binding and never guesses by port',()=>{
  const binding={remote:'SYNTHETIC',pid:456,born:1000.5,epoch:'a'.repeat(64),instance:'session-3'},calls=[];
  const stop=options=>{calls.push(options.binding);return {stopped:true};};
  assert.throws(()=>stopConfiguredOcr({ocr:{}},()=>{},stop),/No bound OCR/);assert.equal(calls.length,0);
  assert.deepEqual(stopConfiguredOcr({ocr:{binding}},()=>{},stop),{stopped:true});assert.deepEqual(calls,[binding]);
});
