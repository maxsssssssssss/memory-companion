import { expect, it } from "vitest";
import { learningModelInput, quizModelInputView } from "./model-input";
it("separates controls from unchanged course text and explicit extras without dropping source metadata",()=>{
 const original={materials:[{materialId:'m1',title:'display filename',kind:'audio',scopeNotice:{unverified:true},paragraphs:[{number:1,text:'[合成ASR] 原样歧义7组',referenceId:'ref_exact',sourceContext:{startSeconds:3,endSeconds:8}}]}],extras:[{kind:'note',text:'explicit user note'}],chapters:[{ref:'c1',batch:'b1'}],node:{explanation:'AI explanation'},history:[{answer:'AI answer'}]};
 const wire=learningModelInput(original);
 expect(wire.materials).toEqual([{materialId:'m1',paragraphs:[{number:1,text:'[合成ASR] 原样歧义7组',referenceId:'ref_exact'}]}]);
 expect(wire.taskContext.materialCatalog[0]).toMatchObject({kind:'audio',scopeNotice:{unverified:true},sourceLocations:[{paragraph:1,context:{startSeconds:3,endSeconds:8}}]});
 expect(wire.materials[0].paragraphs.find(p=>p.number===wire.taskContext.materialCatalog[0].sourceLocations[0].paragraph)?.referenceId).toBe('ref_exact');
 expect(wire.taskContext.materialCatalog[0].transcriptionNotice).toContain('不得无说明修正');expect(wire.extras).toEqual(original.extras);
 expect(wire.taskContext).toMatchObject({node:original.node,history:original.history,chapters:original.chapters});expect(JSON.stringify(wire.materials)).not.toContain('AI explanation');expect(original.materials[0].paragraphs[0].text).toContain('7组');
});
it("removes only backend identity/geometry and repeated layout notices from Quiz input", () => {
 const original={materials:[{materialId:'uuid',title:'课件',kind:'pdf',scopeNotice:{documentId:'parse-id',parseVersion:4,physicalPages:[2],excludedPhysicalPages:[1,3],excludedBlockIds:['blocked-a'],contentVerified:false,warningCodes:['missing_formula']},paragraphs:[
  {number:7,text:'标题\n<table><tr><td>前提</td><td>r1</td></tr></table>\n脚注：条件不满足时不得使用。',referenceId:'r1',sourceContext:{kind:'pdf',physicalPage:2,role:'table',type:'table',renderSize:[800,900],regions:[{bbox:[1,2,3,4],unit:'render_pixel'}],note:'layout only',unknownSemantic:'retain me'}},
  {number:8,text:'不超过，不等于必须小于。',referenceId:'r2',sourceContext:{kind:'pdf',physicalPage:2,role:'text',type:'text',renderSize:[800,900],regions:[{bbox:[2,3,4,5]}],note:'layout only'}}]}],extras:[{kind:'note',text:'个人记录',referenceId:'r3'}],count:3,difficulty:'standard'};
 const baseline=learningModelInput(original), before=JSON.stringify(baseline), wire=quizModelInputView(baseline);
 expect(wire.materials[0].paragraphs.map(p=>p.text)).toEqual(original.materials[0].paragraphs.map(p=>p.text));
 expect(wire.materials[0]).toHaveProperty('material',1);expect(wire.materials[0]).not.toHaveProperty('materialId');
 expect(wire.taskContext.materialCatalog[0].scopeNotice).toEqual({physicalPages:[2],excludedPhysicalPages:[1,3],excludedRegionCount:1,contentVerified:false,warningCodes:['missing_formula']});
 expect(wire.taskContext.materialCatalog[0].sourceLocations[0]).toEqual({referenceIds:['r1'],context:{kind:'pdf',physicalPage:2,role:'table',type:'table',unknownSemantic:'retain me'}});
 expect(wire.taskContext.layoutNotices).toEqual(['layout only']);expect(wire.extras).toEqual(original.extras);
 expect(JSON.stringify(wire)).not.toMatch(/parse-id|blocked-a|renderSize|bbox|uuid/);expect(JSON.stringify(baseline)).toBe(before);
});
it("preserves non-PDF source semantics with exact aliases and fails closed on a missing join", () => {
 const wire=learningModelInput({materials:[{materialId:'audio',title:'录音',kind:'audio',paragraphs:[{number:3,text:'原样转写',referenceId:'r1',sourceContext:{startSeconds:3,endSeconds:8}}]}]});
 expect(quizModelInputView(wire).taskContext.materialCatalog[0].sourceLocations).toEqual([{referenceId:'r1',context:{startSeconds:3,endSeconds:8}}]);
 delete wire.materials[0].paragraphs[0].referenceId;
 expect(()=>quizModelInputView(wire)).toThrow('quiz_reference_missing');
});
it("groups only consecutive PDF references with identical reading semantics and keeps every alias addressable",()=>{
 const base={kind:'pdf',physicalPage:2,role:'text',type:'text',note:'layout unverified'};
 const contexts=[base,{...base},{...base,role:'caption'},{...base,type:'list'},{...base,physicalPage:3},
  {...base,physicalPage:3,readingRelation:{parent:'r1',status:'unverified'}},
  {...base,physicalPage:3,readingRelation:{parent:'r3',status:'unverified'}},base];
 const paragraphs=contexts.map((context,i)=>({number:i+7,text:`[合成] 原文${i}，保留否定与条件。`,referenceId:`r${i+1}`,sourceContext:{...context,renderSize:[800,900],regions:[{bbox:[i,2,3,4]}]}}));
 const input=learningModelInput({materials:[{materialId:'synthetic-pdf',title:'[合成] 阅读顺序',kind:'pdf',paragraphs}],extras:[]});
 const before=JSON.stringify(input),wire=quizModelInputView(input);
 const locations=wire.taskContext.materialCatalog[0].sourceLocations as unknown as Array<{referenceIds:string[];context:Record<string,unknown>}>;
 expect(locations.map(location=>location.referenceIds)).toEqual([['r1','r2'],['r3'],['r4'],['r5'],['r6'],['r7'],['r8']]);
 const expanded=locations.flatMap(location=>location.referenceIds.map(referenceId=>({referenceId,context:location.context})));
 expect(expanded).toEqual(contexts.map(({note:_note,...context},i)=>({referenceId:`r${i+1}`,context})));
 expect(expanded.map(location=>wire.materials[0].paragraphs.find(p=>p.referenceId===location.referenceId)?.text)).toEqual(paragraphs.map(p=>p.text));
 expect(wire.taskContext.layoutNotices).toEqual(['layout unverified']);
 expect(JSON.stringify(input)).toBe(before);
});
it("does not group PDF locations across a paragraph without metadata or across materials",()=>{
 const context={kind:'pdf',physicalPage:1,role:'text',type:'text'};
 const wire=quizModelInputView(learningModelInput({materials:[
  {materialId:'one',title:'[合成] 第一份',kind:'pdf',paragraphs:[
   {number:1,text:'[合成] 前文',referenceId:'r1',sourceContext:context},
   {number:2,text:'[合成] 中间内容',referenceId:'r2'},
   {number:3,text:'[合成] 后文',referenceId:'r3',sourceContext:context}]},
  {materialId:'two',title:'[合成] 第二份',kind:'pdf',paragraphs:[{number:1,text:'[合成] 另一份材料',referenceId:'r4',sourceContext:context}]}]}));
 expect(wire.taskContext.materialCatalog[0].sourceLocations).toEqual([{referenceIds:['r1'],context},{referenceIds:['r3'],context}]);
 expect(wire.taskContext.materialCatalog[1].sourceLocations).toEqual([{referenceIds:['r4'],context}]);
 expect(wire.materials.flatMap(m=>m.paragraphs.map(p=>p.referenceId))).toEqual(['r1','r2','r3','r4']);
});
it("reduces dense PDF location overhead while preserving page ranges, risk and all 269 source bindings",()=>{
 const paragraphs=Array.from({length:269},(_,i)=>({number:i+1,text:`[合成] 第${i+1}块。`,referenceId:`r${i+1}`,sourceContext:{
  kind:'pdf',physicalPage:Math.floor(i/54)+1,role:'text',type:'text',renderSize:[1000,1400],regions:[{bbox:[1,2,3,4]}],note:'layout unverified'}}));
 const scopeNotice={kind:'pdf',documentId:'synthetic-doc',parseVersion:3,physicalPages:[1,2,3,4,5],excludedPhysicalPages:[6,7],excludedBlockIds:['synthetic-excluded'],contentVerified:false,warningCodes:['missing_formula']};
 const input=learningModelInput({materials:[{materialId:'dense-pdf',title:'[合成] 密集短块',kind:'pdf',scopeNotice,paragraphs}]}),wire=quizModelInputView(input);
 const locations=wire.taskContext.materialCatalog[0].sourceLocations as unknown as Array<{referenceIds:string[];context:Record<string,unknown>}>;
 const previousLocations=paragraphs.map(p=>({referenceId:p.referenceId,context:{kind:'pdf',physicalPage:p.sourceContext.physicalPage,role:'text',type:'text'}}));
 expect(locations).toHaveLength(5);
 expect(JSON.stringify(locations).length).toBeLessThan(JSON.stringify(previousLocations).length/4);
 expect(locations.flatMap(location=>location.referenceIds)).toEqual(paragraphs.map(p=>p.referenceId));
 expect(locations.map(location=>location.context)).toEqual([1,2,3,4,5].map(physicalPage=>({kind:'pdf',physicalPage,role:'text',type:'text'})));
 expect(wire.taskContext.materialCatalog[0].scopeNotice).toEqual({kind:'pdf',physicalPages:[1,2,3,4,5],excludedPhysicalPages:[6,7],contentVerified:false,warningCodes:['missing_formula'],excludedRegionCount:1});
 expect(wire.materials[0].paragraphs).toEqual(paragraphs.map(({text,referenceId})=>({text,referenceId})));
 expect(input.taskContext.materialCatalog[0].sourceLocations).toHaveLength(269);
});
