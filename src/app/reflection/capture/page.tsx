import type { Metadata } from "next";

import { ReflectionCapture } from "@/components/daily-reflection/reflection-capture";

export const metadata: Metadata = { title: "开始表达 · Daily Reflection" };

export default async function ReflectionCapturePage({
  searchParams
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams;
  const newValue = query?.new;
  const rawMethod = Array.isArray(query?.method) ? query?.method[0] : query?.method;
  const method = rawMethod === "record" || rawMethod === "upload" || rawMethod === "toy"
    ? rawMethod
    : null;
  const rawPrompt = Array.isArray(query?.prompt) ? query?.prompt[0] : query?.prompt;
  const prompt = rawPrompt?.normalize("NFKC").trim().slice(0, 240) || null;
  return (
    <ReflectionCapture
      forceNew={Array.isArray(newValue) ? newValue[0] === "1" : newValue === "1"}
      method={method}
      prompt={prompt}
    />
  );
}
