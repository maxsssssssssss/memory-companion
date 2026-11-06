import type Database from "better-sqlite3";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import type { PreparationSource } from "@/lib/domain/date-companion-preparation";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import { DcNotFoundError, DcValidationError } from "./errors";
import { DC_EVIDENCE_PROVENANCE_VERSION, DC_EVIDENCE_SOURCE_KIND, dateCompanionEvidenceDigest, stableBridgeDigest } from "./memory-bridge-digest";
import { resolveDateCompanionPersonSourceCatalog } from "./person-source-catalog";
import { buildPersonRelationshipProactiveValueContext, withDateCompanionHomeContext } from "./proactive-value-context";
import { DateCompanionRepository } from "./repository";
import { buildDateCompanionRelationshipQaContext } from "./relationship-qa";

/** Read-only adapter. Temporary recap consent and existing Memory admission stay separate. */
export class PreparationSources {
  private readonly repository: DateCompanionRepository;
  constructor(private readonly database: Database.Database, private readonly options: { memoryDatabase?: Database.Database } = {}) {
    this.repository = new DateCompanionRepository(database);
  }

  private view(accountId: string, relationshipId: string) {
    const view = this.repository.getRelationshipView(accountId, relationshipId);
    if (view.relationship.status !== "active") throw new DcNotFoundError("Relationship not found");
    return view;
  }

  private scopedView(accountId: string, relationshipId: string, interactionIds: string[]): DcRelationshipView {
    const relationship = this.repository.listRelationships(accountId).find(item => item.id === relationshipId);
    if (!relationship) throw new DcNotFoundError("Relationship not found");
    const interactions = [...new Set(interactionIds)].flatMap(id => {
      try {
        return [this.repository.getInteractionDetail(accountId, relationshipId, id)];
      } catch (error) {
        if (error instanceof DcNotFoundError) return [];
        throw error;
      }
    });
    return { relationship, interactions, promises: [] };
  }

  private speakerRole(accountId: string, interactionId: string, speakerId?: string): "self" | "companion" | undefined {
    if (!speakerId) return undefined;
    const row = this.database.prepare(`SELECT role FROM dc_participant_assignments
      WHERE user_id=? AND interaction_id=? AND speaker_id=? AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL`)
      .get(accountId, interactionId, speakerId) as { role: string } | undefined;
    return row?.role === "self" || row?.role === "companion" ? row.role : undefined;
  }

  available(accountId: string, relationshipId: string) {
    const view = this.view(accountId, relationshipId);
    return view.interactions
      .filter(item => item.status === "confirmed" && item.confirmedAt && item.sourceState !== "explicitly_deleted")
      .map(item => ({ id: item.id, recordingDate: item.recordingDate, title: item.originalName.split(/[\\/]/u).at(-1)?.trim() || "相处记录",
        reviewAvailable: this.canonicalSources(accountId, { ...view, interactions: [item] }).length > 0 }));
  }

  validateScope(accountId: string, relationshipId: string, interactionIds: string[]) {
    const available = new Set(this.scopedView(accountId, relationshipId, interactionIds).interactions
      .filter(item => item.status === "confirmed" && item.confirmedAt && item.sourceState !== "explicitly_deleted")
      .map(item => item.id));
    if (new Set(interactionIds).size !== interactionIds.length || interactionIds.some(id => !available.has(id))) {
      throw new DcValidationError("preparation_source_unavailable");
    }
  }

  private temporary(accountId: string, relationshipId: string, interactionIds: string[]): PreparationSource[] {
    return this.canonicalSources(accountId, this.scopedView(accountId, relationshipId, interactionIds));
  }

  /** Only the already selected review. No broad search, model call or Memory bridge. */
  reviewSources(accountId: string, relationshipId: string, interactionId: string): PreparationSource[] {
    return this.temporary(accountId, relationshipId, [interactionId]);
  }

  private canonicalSources(accountId: string, scoped: DcRelationshipView): PreparationSource[] {
    const canonical = new Map(buildDateCompanionRelationshipQaContext(scoped).segments.map(item => [item.id, item]));
    return scoped.interactions.flatMap(interaction => interaction.recapItems.flatMap(recap => {
      if (recap.disposition !== "kept" || interaction.status !== "confirmed" || !interaction.confirmedAt || interaction.sourceState === "explicitly_deleted") return [];
      return recap.evidence.flatMap(evidence => {
        const source = canonical.get(evidence.sourceSegmentId);
        const digest = dateCompanionEvidenceDigest({ userId: accountId, ...evidence });
        const provenance = this.database.prepare(`SELECT e.provenance_version, e.source_kind, p.confirmed_by
          FROM dc_evidence_snapshots e JOIN dc_recap_items r ON r.id=e.recap_item_id AND r.user_id=e.user_id
          JOIN dc_participant_assignments p ON p.user_id=e.user_id AND p.interaction_id=r.interaction_id AND p.speaker_id=e.speaker_id
          WHERE e.user_id=? AND e.id=?`).get(accountId, evidence.id) as { provenance_version: number; source_kind: string; confirmed_by: string | null } | undefined;
        if (!source || source.uploadId !== evidence.uploadId || evidence.contentDigest !== digest
          || provenance?.provenance_version !== DC_EVIDENCE_PROVENANCE_VERSION
          || provenance.source_kind !== DC_EVIDENCE_SOURCE_KIND || !provenance.confirmed_by) return [];
        return [{
          id: evidence.id, interactionId: interaction.id, recordingDate: interaction.recordingDate,
          quote: evidence.quote, origin: "direct_conversation" as const, valid: true,
          speakerRole: source.speaker === "我" ? "self" as const : "companion" as const,
          href: `/date-companion/a/recap?interaction=${encodeURIComponent(interaction.id)}&segment=${encodeURIComponent(evidence.sourceSegmentId)}#full-transcript`,
          fingerprint: stableBridgeDigest([interaction.id, interaction.version, recap.id, recap.version, digest, source.speaker])
        }];
      });
    }));
  }

  personSources(accountId: string, relationshipId: string, allowRetained = false): PreparationSource[] {
    this.scopedView(accountId, relationshipId, []);
    if (!allowRetained) return [];
    const memoryDatabase = this.options.memoryDatabase ?? getMemoryDatabase();
    const input = { dateCompanionDatabase: this.database, memoryDatabase, accountId, relationshipId };
    const catalog = resolveDateCompanionPersonSourceCatalog(input);
    if (catalog.status !== "ready") return [];
    const direct: PreparationSource[] = catalog.sources.map(source => ({
      id: `retained:${source.evidenceSnapshotId}`, interactionId: source.interactionId,
      recordingDate: source.recordingDate, quote: source.quote, origin: "direct_conversation", valid: true,
      speakerRole: this.speakerRole(accountId, source.interactionId, source.speakerId),
      href: `/date-companion/a/recap?interaction=${encodeURIComponent(source.interactionId)}&segment=${encodeURIComponent(source.sourceSegmentId)}#full-transcript`,
      fingerprint: stableBridgeDigest([catalog.mappingVersion, source, this.speakerRole(accountId, source.interactionId, source.speakerId)])
    }));
    // This existing resolver checks publication, receipt, revocation, subject and source origin.
    // It has a bounded recent-memory projection; the full direct conversation catalog above does not.
    const retained = buildPersonRelationshipProactiveValueContext(input);
    const expanded = retained.context ? withDateCompanionHomeContext({ ...input, context: retained.context }) : null;
    const reflections: PreparationSource[] = retained.context?.evidence.filter(source => source.origin === "user_reflection").map(source => ({
      id: `retained:${source.evidenceId}`, interactionId: "", recordingDate: source.recordingDate,
      quote: source.quote, origin: "user_reflection", valid: true,
      href: "/date-companion/a/person", fingerprint: stableBridgeDigest([catalog.mappingVersion, source])
    })) ?? [];
    const known = new Set(direct.map(source => source.id));
    const interactions = this.view(accountId, relationshipId).interactions;
    const selfSources: PreparationSource[] = expanded?.evidence.filter(source => source.origin === "direct_conversation" && source.evidenceId.startsWith("dc_snapshot:")).flatMap(source => {
      const id = `retained:${source.evidenceId.slice("dc_snapshot:".length)}`;
      const interaction = interactions.find(item => item.sourceUploadId === source.uploadId);
      if (known.has(id) || !interaction) return [];
      return [{ id, interactionId: interaction.id, recordingDate: source.recordingDate,
        quote: source.quote, origin: "direct_conversation" as const, valid: true,
        speakerRole: this.speakerRole(accountId, interaction.id, source.speakerId),
        href: `/date-companion/a/recap?interaction=${encodeURIComponent(interaction.id)}&segment=${encodeURIComponent(source.sourceSegmentId)}#full-transcript`,
        fingerprint: stableBridgeDigest([catalog.mappingVersion, source, this.speakerRole(accountId, interaction.id, source.speakerId)]) }];
    }) ?? [];
    return [...direct, ...reflections, ...selfSources];
  }

  search(accountId: string, relationshipId: string, interactionIds: string[], query: string, allowRetained = false): PreparationSource[] {
    const text = query.trim();
    if (!text || text.length > 120) throw new DcValidationError("invalid_search_query");
    const matches = this.repository.search(accountId, relationshipId, text, 100);
    const matchedIds = new Set(matches.flatMap(item => item.evidence.map(source => source.id)));
    const temporary = this.temporary(accountId, relationshipId, interactionIds).filter(source => matchedIds.has(source.id)
      || source.quote.toLocaleLowerCase().includes(text.toLocaleLowerCase()) || source.recordingDate.includes(text));
    const retained = this.personSources(accountId, relationshipId, allowRetained)
      .filter(source => source.quote.toLocaleLowerCase().includes(text.toLocaleLowerCase()));
    return [...temporary, ...retained].slice(0, 30);
  }

  read(accountId: string, relationshipId: string, interactionIds: string[], sourceId: string, allowRetained = false): PreparationSource | null {
    const sources = sourceId.startsWith("retained:")
      ? this.personSources(accountId, relationshipId, allowRetained)
      : this.temporary(accountId, relationshipId, interactionIds);
    return sources.find(source => source.id === sourceId) ?? null;
  }

  promises(accountId: string, relationshipId: string, interactionIds: string[], allowRetained = false) {
    const sources = [...this.temporary(accountId, relationshipId, interactionIds), ...this.personSources(accountId, relationshipId, allowRetained)];
    const byId = new Map(sources.map(source => [source.id.replace(/^retained:/u, ""), source]));
    return this.view(accountId, relationshipId).promises.flatMap(promise => {
      const matched = promise.evidence.map(evidence => byId.get(evidence.id));
      if (matched.length === 0 || matched.some(source => !source)) return [];
      return [{ id: promise.id, text: promise.text, status: promise.status, version: promise.version, sources: matched as PreparationSource[] }];
    });
  }
}
