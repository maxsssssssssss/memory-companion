import type { Metadata } from "next";

import { ReflectionHome } from "@/components/daily-reflection/reflection-home";

export const metadata: Metadata = { title: "今天 · Daily Reflection" };

export default function ReflectionHomePage() {
  return <ReflectionHome />;
}
