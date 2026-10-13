import { LearningAgentSelection, type LearningAgentScope } from "@/lib/domain/learning-agent";
import { LearningError, type LearningRepository } from "./repository";
import { LearningFrameworkRepository, frameworkHash } from "./framework-repository";

/** Rebuild from current sources. The persisted authorization contains hashes and
 * positions, never a second copy of the user's material or personal notes. */
function currentScope(learning: LearningRepository, pageId: string, selection: LearningAgentSelection) {
  learning.get(pageId);
  const framework = new LearningFrameworkRepository(learning), view = framework.view(pageId);
  for (const id of selection.chapterIds) if (!view.chapters.some(c => c.id === id)) throw new LearningError(403, "agent_scope_forbidden");
  for (const id of selection.nodeIds) if (!view.chapters.some(c => c.nodes.some(n => n.id === id))) throw new LearningError(403, "agent_scope_forbidden");
  const paragraphs = new Map<string, Set<number> | null>(selection.materialIds.map(id => [id, null]));
  const chosen = view.chapters.flatMap(c => c.nodes.filter(n => selection.chapterIds.includes(c.id) || selection.nodeIds.includes(n.id)).map(n => ({ c, n })));
  for (const { c, n } of chosen) for (const [index, source] of n.sources.entries()) {
    framework.source(pageId, c.id, n.id, index);
    const current = learning.source(pageId, source.materialId).paragraphs.find(p => p.number === source.paragraph);
    if (!current || JSON.stringify(current.parsed) !== JSON.stringify(source.parsed)) throw new LearningError(409, "source_changed");
    if (!paragraphs.has(source.materialId)) paragraphs.set(source.materialId, new Set());
    paragraphs.get(source.materialId)?.add(source.paragraph);
  }
  const materials = [...paragraphs].sort(([a], [b]) => a.localeCompare(b)).map(([id, numbers]) => {
    const source = learning.source(pageId, id);
    const selected = source.paragraphs.filter(p => numbers === null || numbers.has(p.number));
    if (!selected.length) throw new LearningError(409, "source_changed");
    return { materialId: id, title: source.material.title, kind: source.material.kind, scopeNotice: source.scopeNotice,
      paragraphs: selected };
  });
  const allowed = new Map(materials.map(m => [m.materialId, new Map(m.paragraphs.map(p => [p.number, p]))]));
  // Navigation is only an address book. Generated explanations are not evidence.
  const navigation = view.chapters.flatMap(c => {
    const nodes = c.nodes.filter(n => (selection.chapterIds.includes(c.id) || selection.nodeIds.includes(n.id)
      || n.sources.some(s => selection.materialIds.includes(s.materialId)))
      && n.sources.length > 0 && n.sources.every((s, index) => {
        const paragraph = allowed.get(s.materialId)?.get(s.paragraph);
        // Whole-material authorization does not rebind an old framework node
        // to the same paragraph number in a newer parsed document.
        if (!paragraph || JSON.stringify(paragraph.parsed) !== JSON.stringify(s.parsed)) return false;
        try { framework.source(pageId, c.id, n.id, index); return true; }
        catch (error) { if (error instanceof LearningError) return false; throw error; }
      })).map(n => ({
      id: n.id, title: n.title, sources: n.sources.map(s => ({ materialId: s.materialId, paragraph: s.paragraph })),
      ...(selection.includeNotes && n.note ? { note: n.note } : {}),
      ...(selection.includeSupplements && n.supplement ? { supplement: n.supplement } : {})
    }));
    return nodes.length ? [{ id: c.id, title: c.title, nodes }] : [];
  });
  const fingerprint = frameworkHash(JSON.stringify({ materials: materials.map(m => ({ materialId: m.materialId, scopeNotice: m.scopeNotice,
    paragraphs: m.paragraphs.map(({ text, ...p }) => ({ ...p, hash: frameworkHash(text) })) })),
    // A selected note/supplement change invalidates the frozen authorization.
    extras: navigation.flatMap(c => c.nodes.filter(n => "note" in n || "supplement" in n).map(n => ({ id: n.id,
      note: "note" in n ? frameworkHash(n.note!) : null, supplement: "supplement" in n ? frameworkHash(n.supplement!) : null }))) }));
  return { materials, navigation, fingerprint };
}

export function freezeLearningAgentScope(learning: LearningRepository, pageId: string, input: unknown): LearningAgentScope {
  const selection = LearningAgentSelection.parse(input), current = currentScope(learning, pageId, selection);
  return { version: 1, pageId, selection, fingerprint: current.fingerprint,
    sources: current.materials.map(m => ({ materialId: m.materialId, paragraphs: m.paragraphs.map(p => p.number) })) };
}

export function readLearningAgentScope(learning: LearningRepository, pageId: string, input: unknown) {
  const scope = input as LearningAgentScope;
  if (scope?.version !== 1 || scope.pageId !== pageId || !scope.fingerprint) throw new LearningError(403, "agent_scope_forbidden");
  const selection = LearningAgentSelection.parse(scope.selection), current = currentScope(learning, pageId, selection);
  if (current.fingerprint !== scope.fingerprint) throw new LearningError(409, "source_changed");
  return { scope, ...current };
}
