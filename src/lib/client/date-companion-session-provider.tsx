"use client";

import {
  createContext,
  useContext,
  type ReactNode
} from "react";

import {
  useDateCompanionSession,
  type DateCompanionSessionOptions,
  type DateCompanionSessionValue
} from "./date-companion-session";

const DateCompanionSessionContext = createContext<DateCompanionSessionValue | null>(null);

type DateCompanionSessionProviderProps = {
  children: ReactNode;
  options?: DateCompanionSessionOptions;
};

export function DateCompanionSessionProvider({
  children,
  options = {}
}: DateCompanionSessionProviderProps) {
  const value = useDateCompanionSession(options);

  return (
    <DateCompanionSessionContext.Provider value={value}>
      {children}
    </DateCompanionSessionContext.Provider>
  );
}

export function usePersistentDateCompanionSession(): DateCompanionSessionValue {
  const session = useContext(DateCompanionSessionContext);
  if (!session) {
    throw new Error("usePersistentDateCompanionSession must be used within DateCompanionSessionProvider");
  }
  return session;
}
