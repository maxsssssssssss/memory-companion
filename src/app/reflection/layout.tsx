import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ReflectionAppShell } from "@/components/daily-reflection/reflection-app-shell";
import {
  isDailyReflectionBrowserRecordingEnabled,
  isDailyReflectionToySyncEnabled,
  isDailyReflectionUploadEnabled
} from "@/lib/server/daily-reflection/runtime-config";

export const metadata: Metadata = {
  title: "Daily Reflection",
  description: "把当时的真实表达整理成可以继续使用的卡片和长期记忆。"
};

// The release gate is a runtime deployment setting. Without this boundary,
// Next can prerender the disabled state during `next build` and permanently
// bake a 404 into an artifact that is enabled by PM2 only at runtime.
export const dynamic = "force-dynamic";

export default function ReflectionLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (!isDailyReflectionUploadEnabled()) notFound();
  return (
    <ReflectionAppShell
      browserRecordingEnabled={isDailyReflectionBrowserRecordingEnabled()}
      toySyncEnabled={isDailyReflectionToySyncEnabled()}
    >
      {children}
    </ReflectionAppShell>
  );
}
