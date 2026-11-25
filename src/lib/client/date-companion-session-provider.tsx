"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode
} from "react";

import {
  useDateCompanionSession,
  type DateCompanionSessionOptions,
  type DateCompanionSessionValue
} from "./date-companion-session";
import type { HomeMaterialRead } from "./date-companion-proactive-value";

const DateCompanionSessionContext = createContext<DateCompanionSessionValue | null>(null);
const HomeMaterialReadContext = createContext<HomeMaterialRead | null>(null);

type DateCompanionSessionProviderProps = {
  children: ReactNode;
  options?: DateCompanionSessionOptions;
};

export function DateCompanionSessionProvider({
  children,
  options = {}
}: DateCompanionSessionProviderProps) {
  const value = useDateCompanionSession(options);
  const accountId = value.auth.status === "authenticated" ? value.auth.user.id : null;
  const relationshipId = value.relationshipState.status === "ready" ? value.relationshipState.relationship.id : null;
  const mapping = value.memoryBridgeState.status === "ready" ? value.memoryBridgeState.mapping : null;
  const personId = mapping?.status === "confirmed" ? mapping.companionPersonId : null;
  const materialRead = useMemo<HomeMaterialRead | null>(
    () => accountId && relationshipId && personId ? { current: null } : null,
    [accountId, relationshipId, personId, mapping?.version]
  );

  return (
    <DateCompanionSessionContext.Provider value={value}>
      <HomeMaterialReadContext.Provider value={materialRead}>{children}</HomeMaterialReadContext.Provider>
    </DateCompanionSessionContext.Provider>
  );
}

export function useHomeMaterialRead() {
  return useContext(HomeMaterialReadContext);
}

export function usePersistentDateCompanionSession(): DateCompanionSessionValue {
  const session = useContext(DateCompanionSessionContext);
  if (!session) {
    throw new Error("usePersistentDateCompanionSession must be used within DateCompanionSessionProvider");
  }
  return session;
}
