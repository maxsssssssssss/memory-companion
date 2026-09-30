import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LearningShell } from "@/components/learning/learning-shell";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export const metadata: Metadata = { title: "学习整理 · Daily Brief" };
export const dynamic = "force-dynamic";
export default function LearningLayout({ children }: { children: ReactNode }) {
  return <LearningShell dailyReflectionEnabled={isDailyReflectionUploadEnabled()}>{children}</LearningShell>;
}
