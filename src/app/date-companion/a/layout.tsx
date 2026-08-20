import type { ReactNode } from "react";

import { DateCompanionSessionProvider } from "@/lib/client/date-companion-session-provider";

export default function DateCompanionAppLayout({ children }: { children: ReactNode }) {
  return <DateCompanionSessionProvider>{children}</DateCompanionSessionProvider>;
}
