import { ZodError } from "zod";
import { StartLearningFramework, GeneratedLearningFramework, type GeneratedFramework } from "@/lib/domain/learning-framework";
import { StructuredJsonResponseError } from "@/lib/server/openai/structured-json";
import { LearningError, type LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { generateLearningFramework, learningGenerationConfig, LEARNING_FRAMEWORK_PROMPT } from "./framework-generator";
import { sourceBatches } from "./generation-sources";
import { GenerationParts } from "./generation-parts";

// Dependency injection is for isolated tests; no runtime mock/fixture switch exists.
export async function organizeLearningText(learning: LearningRepository, pageId: string, input: unknown,
  dependencies = { configure: learningGenerationConfig, generate: generateLearningFramework }, assertCurrent?: () => void) {
  const value = StartLearningFramework.parse(input);
  const repository = new LearningFrameworkRepository(learning);
  if (repository.existing(pageId, value) && !value.resume) return repository.view(pageId);
  const config = dependencies.configure(); // Missing config makes no new attempt or Provider request.
  const started = repository.begin(pageId, value, config.maxInputChars, (config.requestTimeoutMs ?? 120_000) + 30_000);
  if (!started.created) return repository.view(pageId);
  let responseReceived = false;
  try {
    repository.recordConfig(pageId, value.id, config);
    const timeout = config.requestTimeoutMs ?? 120_000;
    const batches = sourceBatches(started.inputs, Math.min(config.maxInputChars - LEARNING_FRAMEWORK_PROMPT.length - 4000, config.maxOutputTokens * 2));
    const parts = new GenerationParts(learning,pageId,"framework",value.id,value.materialIds,()=>{assertCurrent?.();repository.assertSources(pageId,value.id);},timeout);
    parts.plan(batches.map((materials,i)=>({id:`read-${i}`,input:{materials,prompt:LEARNING_FRAMEWORK_PROMPT,model:config.model}})));
    const results: GeneratedFramework[] = [];
    for(const [i,materials] of batches.entries()) {
      results.push(await parts.execute(`read-${i}`,diagnostics=>dependencies.generate(config,materials as typeof started.inputs,AbortSignal.timeout(timeout),d=>{
        diagnostics(d); repository.diagnostics(pageId,value.id,d);
      }),raw=>{
        const v=GeneratedLearningFramework.parse(raw);
        const used=new Set<string>();
        for(const c of v.chapters)for(const n of c.nodes)for(const r of n.sources){
          if(!materials.some(m=>m.materialId===r.materialId&&m.paragraphs.some(p=>p.number===r.paragraph)))throw new LearningError(422,"framework_invalid_source");
          used.add(r.materialId);
        }
        if(materials.some(m=>!used.has(m.materialId)))throw new LearningError(422,"framework_missing_material");
        return v;
      }));
    }
    const result = results.length===1 ? results[0] : {
      overview: `已按原文顺序整理全部 ${results.length} 个部分；各部分的解释与来源保留在下方章节中。`,
      chapters:results.flatMap(r=>r.chapters)
    };
    responseReceived = true;
    learning.database.transaction(() => {
      assertCurrent?.();
      repository.validating(pageId, value.id);
      repository.complete(pageId, value.id, result, results.length>1);
    }).immediate();
  } catch (error) {
    const code = error instanceof LearningError ? error.code
      : error instanceof ZodError || error instanceof StructuredJsonResponseError ? "framework_invalid_result"
        : responseReceived ? "framework_save_failed" : "framework_provider_failed";
    // A deleted page must never be recreated; preserve the deletion error instead of its body.
    repository.fail(pageId, value.id, code);
  }
  return repository.view(pageId);
}
