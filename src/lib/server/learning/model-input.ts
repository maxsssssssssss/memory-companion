/** Learning-only wire layout. Content, selected user additions and task controls are separate.
 * No text is shortened, corrected or used as a substitute for a stored source. */
type Material = { materialId: string; title: string; kind?: string; scopeNotice?: unknown;
  paragraphs: Array<{ number: number; text: string; referenceId?: string; sourceContext?: unknown }> };
export function learningModelInput(input: { materials: Material[]; extras?: unknown; [key: string]: unknown }) {
  const { materials, extras, ...task } = input;
  return {
    materials: materials.map(m => ({ materialId: m.materialId, paragraphs: m.paragraphs.map(p => ({
      number: p.number, text: p.text, ...(p.referenceId ? { referenceId: p.referenceId } : {})
    })) })),
    ...(extras === undefined ? {} : { extras }),
    taskContext: { ...task, materialCatalog: materials.map(m => ({ materialId: m.materialId, displayTitle: m.title,
      kind: m.kind ?? "unspecified", ...(m.scopeNotice ? { scopeNotice: m.scopeNotice } : {}),
      ...(m.kind === "audio" ? { transcriptionNotice: "原始ASR转写，内容未核实；名称、术语、数字可能存在歧义。不得无说明修正或将歧义名称直接当数量。依据其他材料推断时说明推断及来源；不足以唯一判断的题不出。" } : {}),
      // Paragraph is the lossless join to the referenceId already sent with the
      // text. Repeating each 68-character ID here consumed the selected-note budget.
      sourceLocations: m.paragraphs.filter(p => p.sourceContext).map(p => ({ paragraph: p.number, context: p.sourceContext }))
    })) }
  };
}

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Quiz references already resolve every source on the server. Keep the reading
 * context, not the coordinates/identities needed to open an original afterwards.
 * Other learning consumers retain their existing wire contract. */
export function quizModelInputView<T extends ReturnType<typeof learningModelInput>>(wire: T) {
  const layoutNotices = new Set<string>();
  const materials = wire.materials.map((m, index) => ({ material: index + 1,
    paragraphs: m.paragraphs.map(p => ({ text: p.text, referenceId: p.referenceId })) }));
  const materialCatalog = wire.taskContext.materialCatalog.map((m, index) => {
    const { materialId: _materialId, sourceLocations, scopeNotice, ...semantic } = m;
    const original = record(scopeNotice);
    const scope = original ? (() => {
      const { documentId: _document, parseVersion: _version, excludedBlockIds, ...risk } = original;
      return { ...risk, ...(Array.isArray(excludedBlockIds) ? { excludedRegionCount: excludedBlockIds.length } : {}) };
    })() : scopeNotice;
    const paragraphs = new Map(wire.materials[index].paragraphs.map((p, order) => [p.number, { ...p, order }]));
    const locations: Array<{ referenceId: string; context: unknown } | { referenceIds: string[]; context: Record<string, unknown> }> = [];
    let previousContext: string | undefined, previousOrder = -2;
    for (const location of sourceLocations) {
      const context = record(location.context), paragraph = paragraphs.get(location.paragraph);
      if (!paragraph?.referenceId) throw new Error("quiz_reference_missing");
      // Unknown semantic fields are preserved; only concrete rendering fields
      // from our PDF source builder are omitted. No OCR text is rewritten.
      if (!context || context.kind !== "pdf") {
        locations.push({ referenceId: paragraph.referenceId, context: location.context });
        previousContext = undefined;
        continue;
      }
      const { renderSize: _render, regions: _regions, note, ...reading } = context;
      if (typeof note === "string") layoutNotices.add(note);
      const reduced = { ...reading, ...(note !== undefined && typeof note !== "string" ? { note } : {}) };
      const key = JSON.stringify(reduced), previous = locations.at(-1);
      // Group only adjacent paragraphs with identical reading context. Explicit
      // aliases retain their order; page, role, type and semantic changes split groups.
      if (previous && "referenceIds" in previous && key === previousContext && paragraph.order === previousOrder + 1) {
        previous.referenceIds.push(paragraph.referenceId);
      } else locations.push({ referenceIds: [paragraph.referenceId], context: reduced });
      previousContext = key;
      previousOrder = paragraph.order;
    }
    return { ...semantic, material: index + 1, ...(scope === undefined ? {} : { scopeNotice: scope }), sourceLocations: locations };
  });
  return { ...wire, materials, taskContext: { ...wire.taskContext, materialCatalog,
    ...(layoutNotices.size ? { layoutNotices: [...layoutNotices] } : {}) } };
}
export const LEARNING_INPUT_BOUNDARY = `输入分三层：materials[*].paragraphs[*].text才是本次选定的课程原文；extras仅为用户显式选中的个人笔记或补充；taskContext包含任务设置、章节定位、问题历史、来源位置、材料显示名及处理/风险元信息，不是课程正文。materialId/paragraph/referenceId用于定位，不能成为课程知识。不能把应用的排除范围、解析状态或质量提示整理为课程概念，也不能把显示文件名当原文标题；原文标题需引用实际正文段落。范围与风险仍约束整次生成，不删除、不猜缺失内容，也不声称已核实。\n音频正文是ASR原样转写，不是讲稿真值。名称与数量有歧义时保留原写法和不确定性；其他所选原文支持某种理解时只能明确说明是推断并引用，不能冒充录音原话。不依赖未解决歧义设唯一答案。基础解释和假设例子仍可写补充栏，但解释限制不等于允许修改材料规则；材料未允许时不要建议改变容量、阈值或排队次序。`;
