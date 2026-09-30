// Explicit UI-test preload only: no network model/OCR requests, no user material.
require('./learning-framework-browser-mock.cjs');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.LEARNING_FRAMEWORK_MOCK_OUTPUT;
const upstream = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('http://127.0.0.1:9/')) {
    if (init?.method === 'DELETE') return Response.json({ deleted: true });
    if (!url.endsWith('/parse-pdf')) throw Error('Unexpected mock path');
    const r = JSON.parse(init.body), n = r.page_range.start;
    const control = JSON.parse(fs.readFileSync(path.join(root, 'mock-control.json'), 'utf8'));
    fs.appendFileSync(path.join(root,'pdf-mock-calls.jsonl'), JSON.stringify({kind:'in_memory_pdf_mock',page:n})+'\n');
    if (!Buffer.from(r.pdf_base64,'base64').includes(Buffer.from('SYNTHETIC-TEST-ONLY'))) throw Error('Non synthetic PDF');
    await new Promise(resolve => setTimeout(resolve, 1700));
    if (n === 2 || control.pdfMode === 'fail') return Response.json({request_id:r.request_id,status:'failed'}, {status:503});
    const text = '[合成测试] 条件与结论：只有满足适用前提，才能使用规则。此文字为 UI 测试替身，不是 OCR 结果。';
    const bbox = [40,65,550,110];
    const blocks = [{block_id:1,type:'text',raw_content:text,content:text,bbox,order:1,polygon_points:null,
      sources:[{document_sha256:r.sha256,physical_page:n,bbox}],quality:{status:'unverified',warnings:control.pdfMode === 'blocked' ? ['formula_unverified'] : control.pdfMode === 'warning' ? ['[合成风险] 请对照原页检查否定词'] : []}}];
    return Response.json({service_version:'ocr-pdf-trial-0.1',request_id:r.request_id,status:'completed',publishable:true,
      document:{document_id:r.document_id,sha256:r.sha256,physical_page_count:3,selected_physical_pages:[n],selected_pdf_sha256:r.sha256},
      pages:[{physical_page:n,page_index:n-1,selection_index:0,render_size:{width:600,height:800},pdf_geometry:{physical_page:n,mediabox_pt:[0,0,600,800],cropbox_pt:[0,0,600,800],rotation_degrees:0,display_size_pt:[600,800]},blocks,
        coverage:{detected_regions:1,output_blocks:1,vl_requests:0,semantic_completeness:'unverified',issues:[]},raw_paddle:{prunedResult:{parsing_res_list:[{block_id:1,block_content:text,block_label:'text',block_bbox:bbox}]}},status:'completed',quality_status:'unverified'}],
      coverage:{requested_pages:1,completed_pages:1,partial:false,failures:[],semantic_completeness:'unverified'},parser:{paddleocr:'SYNTHETIC',paddlex:'SYNTHETIC',model:'UI MOCK NO OCR',backend:'in-memory',profile:{}},authorization:'SYNTHETIC ONLY'});
  }
  if (url === 'https://tokenhub.vision-intelligence.tech/v1/responses') {
    const req = JSON.parse(init.body), payload = JSON.parse(req.input.at(-1).content);
    if (payload.count) {
      if (payload.materials.some(m=>m.paragraphs.some(p=>!p.text.includes('[合成测试]')))) throw Error('Only synthetic content allowed');
      fs.appendFileSync(path.join(root,'mock-calls.jsonl'),JSON.stringify({kind:'quiz',materials:payload.materials.length})+'\n');
      await new Promise(resolve=>setTimeout(resolve,1800));
      const refs=[...payload.materials.flatMap(m=>m.paragraphs.map(p=>p.referenceId)),...(payload.extras??[]).map(e=>e.referenceId)];
      const value={contractVersion:'references-v2',title:'[合成测试] 条件与反例',reason:payload.count>3?'[模拟] 所选范围只支持 3 道不同题目。':null,
        items:Array.from({length:Math.min(3,payload.count)},(_,i)=>({stem:`[合成测试 ${i+1}] 不满足规则的适用前提时，应如何判断？`,kind:'concept',stemEvidenceIds:refs,explanationEvidenceIds:refs,
          options:[{id:'A',text:'不能直接应用这条规则',reason:'需要先满足适用前提。',evidenceIds:refs},{id:'B',text:'说明应用规则后未达标',reason:'尚不具备适用条件，不能推断执行结果。',evidenceIds:refs},{id:'C',text:'可以忽略前提直接判断',reason:'材料明确要求检查前提。',evidenceIds:refs}],correctOptionId:'A',explanation:'[模拟解析] 先检查适用前提，再判断结果。两种情形不能混为一谈。',hint:'请先检查题目给定的条件。'}))};
      return new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:'resp_ui_synthetic',object:'response',status:'completed',error:null,incomplete_details:null,output:[{id:'msg_synthetic',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value),annotations:[]}]}],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
    }
  }
  return upstream(input,init);
};
