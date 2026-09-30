// Explicit isolated Browser validation only, never the user runtime.
require('../learning-framework-browser-mock.cjs');
const fs=require('node:fs'),path=require('node:path');
const previous=globalThis.fetch;
globalThis.fetch=async function(input,init){
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(url==='http://127.0.0.1:9/parse-pdf'){
    const value=JSON.parse(init.body);
    fs.appendFileSync(path.join(process.env.LEARNING_FRAMEWORK_MOCK_OUTPUT,'pdf-mock-calls.jsonl'),JSON.stringify({kind:'synthetic_pdf_failure',requestId:value.request_id})+'\n');
    await new Promise(r=>setTimeout(r,5000));
    return Response.json({request_id:value.request_id,status:'failed'},{status:503});
  }
  return previous(input,init);
};
