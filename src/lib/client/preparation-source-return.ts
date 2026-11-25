import type { PreparationSource, PreparationView } from "@/lib/domain/date-companion-preparation";

// One same-tab trip to a source record. Never persist a second copy of server
// history. On return, quoted/derived material needs a fresh authorized read.
type ReturnPoint = { accountId: string; discussion: PreparationView };
let point: ReturnPoint | null = null;

function pendingSource(source: PreparationSource): PreparationSource {
  return { ...source, valid: false, quote: "", href: "", speakerRole: undefined };
}

export function rememberPreparationSourceReturn(accountId: string, view: PreparationView) {
  point = { accountId, discussion: {
    ...view,
    // The history of selections is sufficient to place retained/withdrawn
    // notes. Event bodies can also contain the original evidence.
    events: view.events.filter(event => event.kind === "select" || event.kind === "remove").map(event => ({
      ...event, text: "", data: { itemId: event.data.itemId, previousStatus: event.data.previousStatus }
    })),
    messages: view.messages.map(message => ({
      ...message, text: message.role === "assistant" && message.sources.length ? "" : message.text,
      sources: message.sources.map(pendingSource)
    })),
    items: view.items.map(item => ({
      ...item, text: item.status === "suggested" && item.sources.length ? "" : item.text,
      sources: item.sources.map(pendingSource)
    }))
  } };
}

export function preparationSourceReturn(accountId: string, relationshipId: string, discussionId?: string | null) {
  return point?.accountId === accountId && point.discussion.relationshipId === relationshipId &&
    point.discussion.id === discussionId ? point.discussion : undefined;
}

export function forgetPreparationSourceReturn(view: PreparationView) {
  if (point?.discussion === view) point = null;
}

export function keepPreparationSourceReturnFor(accountId?: string, relationshipId?: string, discussionId?: string | null) {
  if (!point || point.accountId !== accountId || point.discussion.relationshipId !== relationshipId ||
    point.discussion.id !== discussionId) point = null;
}
