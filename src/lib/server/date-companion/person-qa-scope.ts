import type { DateCompanionPersonSourceCatalog, DateCompanionRelationshipPersonSource } from "@/lib/domain/date-companion-person-source";
import { QaTurnError } from "@/lib/server/retrieval/qa-provider";
import type { PersonEvidence } from "@/lib/server/person/types";
import { DcNotFoundError } from "./errors";
import { resolveProductionDateCompanionPersonSourceCatalog } from "./person-source-catalog";
import type { PriorCitation } from "./qa-prior-sources";

type ScopeIdentity = { accountId: string; relationshipId: string; personId: string; mappingVersion: number; withdrawalVersion?: string };

const compact = (value: string) => value.replace(/\s+/gu, " ").trim();

// Browser sentences identify sources by segment ID only. Ambiguous IDs must
// never be put into the provider's evidence universe, even across two uploads.
function uniqueSources(sources: DateCompanionRelationshipPersonSource[]) {
  const unique = new Map<string, DateCompanionRelationshipPersonSource>();
  const duplicates = new Set<string>();
  for (const source of sources) {
    if (unique.has(source.sourceSegmentId)) duplicates.add(source.sourceSegmentId);
    unique.set(source.sourceSegmentId, source);
  }
  for (const id of duplicates) unique.delete(id);
  return unique;
}

export function openDateCompanionPersonQaScope(
  identity: ScopeIdentity,
  read: (input: { accountId: string; relationshipId: string }) => DateCompanionPersonSourceCatalog
    = resolveProductionDateCompanionPersonSourceCatalog
) {
  function readCurrent() {
    let catalog;
    try {
      catalog = read({ accountId: identity.accountId, relationshipId: identity.relationshipId });
    } catch (error) {
      if (error instanceof DcNotFoundError) throw new QaTurnError("qa_scope_changed");
      throw error;
    }
    if (catalog.status !== "ready" || catalog.relationshipId !== identity.relationshipId
      || catalog.companionPersonId !== identity.personId || catalog.mappingVersion !== identity.mappingVersion
      || catalog.withdrawalVersion !== identity.withdrawalVersion) {
      throw new QaTurnError("qa_scope_changed");
    }
    return uniqueSources(catalog.sources);
  }
  const sources = readCurrent();
  return {
    includes(evidence: PersonEvidence) {
      const source = sources.get(evidence.sourceSegmentId);
      return evidence.accountId === identity.accountId && source?.uploadId === evidence.uploadId
        && compact(source.quote) === compact(evidence.quote);
    },
    matchesRevision(citation: PriorCitation) {
      const source = sources.get(citation.sourceSegmentId);
      return Boolean(source?.contentDigest && source.uploadId === citation.uploadId
        && source.contentDigest === citation.revision && source.authorizationRevision === citation.authorizationRevision);
    },
    requiresRevision(citation: PriorCitation) {
      return Boolean(citation.authorizationRevision || sources.get(citation.sourceSegmentId)?.authorizationRevision);
    },
    assertCurrent(segmentIds: readonly string[]) {
      const current = readCurrent();
      for (const id of segmentIds) {
        if (!sources.has(id) || JSON.stringify(current.get(id)) !== JSON.stringify(sources.get(id))) {
          throw new QaTurnError("qa_scope_changed");
        }
      }
    }
  };
}
