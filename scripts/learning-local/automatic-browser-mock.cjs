// Synthetic browser validation only. Never enabled in the user's runtime.
require('../learning-workflow-browser-mock.cjs');
const fs = require('node:fs'), path = require('node:path');
const upstream = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://tokenhub.vision-intelligence.tech/v1/responses') {
    const request = JSON.parse(init.body), wire = JSON.parse(request.input.at(-1).content);
    const payload = {...wire, ...wire.taskContext};
    // Adapt this old synthetic generator to the current compact wire. These IDs
    // exist only inside the mock; the real application receives request aliases.
    payload.materials=payload.materials.map((m,index)=>({...m,
      materialId:m.materialId??`synthetic-material-${index+1}`,
      title:wire.taskContext?.materialCatalog?.find(c=>m.materialId?c.materialId===m.materialId:c.material===m.material)?.displayTitle??'[合成测试] 学习材料',
      paragraphs:m.paragraphs.map((p,i)=>({...p,number:p.number??i+1}))}));
    request.input.at(-1).content = JSON.stringify(payload);
    const response = await upstream(input, {...init, body:JSON.stringify(request)});
    if (!response.ok) return response;
    const text = await response.text();
    const events = text.split('\n').map(line => {
      if (!line.startsWith('data: ')) return line;
      const event = JSON.parse(line.slice(6));
      const part = event.response?.output?.[0]?.content?.[0];
      if (part?.text) {
        const answer=JSON.parse(part.text);
        if(payload.count){
          answer.referenceScope=wire.taskContext.referenceScope;
          answer.materialPlan=payload.materials.map((m,index)=>({material:index+1,contribution:'[合成测试] 条件和反例依据',references:m.paragraphs.map(p=>p.referenceId)}));
          answer.items=answer.items.map(({explanation,explanationEvidenceIds,hint,...item})=>({...item,scenario:null,
            options:item.options.map(({reason,evidenceIds,...option})=>({...option,reasonParts:[{text:reason,evidenceIds}]}))}));
        }
        else if(Array.isArray(answer.chapters))for(const chapter of answer.chapters)for(const node of chapter.nodes)node.sources=node.sources.map(source=>{
          const ref=payload.materials.find(m=>m.materialId===source.materialId)?.paragraphs.find(p=>p.number===source.paragraph)?.referenceId;
          if(!ref)throw Error('Missing synthetic source alias');return ref;
        });
        part.text=JSON.stringify(answer);
      }
      return 'data: '+JSON.stringify(event);
    }).join('\n');
    return new Response(events,{status:response.status,headers:response.headers});
  }
  return upstream(input,init);
};
