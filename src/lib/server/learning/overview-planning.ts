import { z } from "zod";
import { ReferencedOverview, ReferencedOverviewItem } from "@/lib/domain/learning-study";
import type { LearningStudyRepository } from "./study-repository";
import { sourceRequest, sourceBatches, sourceSubset, type SourceMaterial } from "./generation-sources";
import { LearningError } from "./repository";

type Input=NonNullable<ReturnType<LearningStudyRepository["beginOverview"]>>;
const item=ReferencedOverviewItem.extend({sources:z.array(z.string().regex(/^r[1-9]\d*$/)).min(1).max(100)});
export const CompactOverview=ReferencedOverview.extend({items:z.array(z.unknown()).max(200)});
export function overviewRequest(request:Input) {
  const compact=sourceRequest(request.materials);
  // Chapter/source membership is a routing constraint, not another copy of every
  // generated node title or explanation. Actual paragraph text remains below.
  const chapters=request.chapters.map(c=>({...c,nodes:[{sources:[...new Set(c.nodes.flatMap(n=>n.sources.map(r=>compact.reverse.get(`${r.materialId}:${r.paragraph}`))).filter((r):r is string=>Boolean(r)))]}]}));
  return { input:{...compact.input,taskContext:{...compact.input.taskContext,chapters}},
    decode(raw:unknown){
      const value=CompactOverview.parse(raw);
      return {...value,items:value.items.map(raw=>{
        const checked=item.safeParse(raw);
        if(!checked.success)return {rejected:"invalid_structure"};
        if(checked.data.chapterRefs.some(ref=>!chapters.some(c=>c.ref===ref)))return {rejected:"unknown_chapter"};
        try{return {...checked.data,sources:checked.data.sources.map(compact.resolve)};}
        catch(e){if(e instanceof LearningError)return {rejected:"source_outside_scope"};throw e;}
      })};
    } };
}
export function overviewBatches(request:Input,target:number):Input[] {
  if(JSON.stringify(overviewRequest(request).input).length<=target)return [request];
  const batches:Input[]=[];
  // Each cross-batch chapter pair is inspected with actual source paragraphs.
  // Titles route the work; edited explanations and old summaries are not evidence.
  for(let i=0;i<request.chapters.length;i++)for(let j=i+1;j<request.chapters.length;j++) {
    const a=request.chapters[i],b=request.chapters[j];if(a.batch===b.batch)continue;
    const parts=(c:typeof a)=>sourceBatches(sourceSubset(request.materials,c.nodes.flatMap(n=>n.sources)),Math.max(1000,Math.floor(target/3)));
    for(const left of parts(a))for(const right of parts(b)){
      const merged:SourceMaterial[]=[];
      for(const m of [...left,...right]){let existing=merged.find(x=>x.materialId===m.materialId);if(!existing){existing={...m,paragraphs:[]};merged.push(existing);}
        for(const p of m.paragraphs){
          const prior=existing.paragraphs.find(x=>x.number===p.number);
          if(!prior)existing.paragraphs.push({...p});
          else if(prior.text!==p.text)prior.text+=`\n〔同一原段落的另一已选片段，未呈现部分不可推测〕\n${p.text}`;
        }}
      batches.push({chapters:[a,b],materials:merged as Input["materials"]});
    }
  }
  return batches;
}
