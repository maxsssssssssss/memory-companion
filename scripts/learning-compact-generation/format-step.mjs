import OpenAI from 'openai';import fs from 'node:fs';
const root=process.env.LEARNING_CLOSURE_ROOT,label=process.argv[2],schema={type:'object',properties:{code:{type:'string',enum:['wire-constraint-47']}},required:['code'],additionalProperties:false};
const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY,baseURL:'https://tokenhub.vision-intelligence.tech/v1',organization:null,project:null,maxRetries:0,timeout:240000,logLevel:'off',fetchOptions:{redirect:'error'},...(process.env.OPENAI_AUTH_HEADER_MODE==='raw'?{defaultHeaders:{Authorization:process.env.OPENAI_API_KEY}}:{})});
let result={label,status:'UNKNOWN'};
try{const stream=await client.responses.create({model:'deepseek-v4-pro',reasoning:{effort:'none'},store:false,stream:true,max_output_tokens:256,
 text:{format:label==='F1'?{type:'json_schema',name:'compact_capability',strict:true,schema}:{type:'json_object'}},
 input:[{role:'system',content:'This is a synthetic output-format capability check, not learning material. Respond with one JSON object.'},{role:'user',content:'Return exactly {"code":"requested-free-value","extra":1}.'}]},{signal:AbortSignal.timeout(240000),maxRetries:0});
 for await(const event of stream)if(['response.completed','response.failed','response.incomplete'].includes(event.type)){
  const r=event.response;const text=r.output?.filter(x=>x.type==='message').flatMap(x=>x.content).filter(x=>x.type==='output_text').map(x=>x.text).join('');
  result={label,status:r.status,text,returnedFormat:r.text,usage:r.usage??null,exactSchemaEnforcementObserved:label==='F1'&&text?.trim()==='{"code":"wire-constraint-47"}'};
 }console.log(JSON.stringify(result));
}catch(e){result={label,status:'failed',errorName:e.name,httpStatus:e.status??null};console.log(JSON.stringify(result));}
finally{fs.writeFileSync(root+'/'+label+'-result.json',JSON.stringify(result,null,2));}
