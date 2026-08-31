"use client";

import { GlobalProductEntry } from "@/components/product-system/global-product-entry";

type CompanionModulesProps = {
  accountId: string;
  dailyReflectionEnabled?: boolean;
  userLabel: string;
  onLogout: () => Promise<void> | void;
};

export function CompanionModules({
  accountId,
  dailyReflectionEnabled = false,
  userLabel,
  onLogout
}: CompanionModulesProps) {
  return (
    <GlobalProductEntry
      accountId={accountId}
      dailyReflectionEnabled={dailyReflectionEnabled}
      onLogout={onLogout}
      userLabel={userLabel}
    />
  );
}
