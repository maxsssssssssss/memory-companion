import type { Metadata } from "next";

import { ReflectionCapture } from "@/components/daily-reflection/reflection-capture";

export const metadata: Metadata = { title: "开始讲述 · Daily Reflection" };

export default async function ReflectionCapturePage({
  searchParams
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = await searchParams;
  const newValue = query?.new;
  const rawMethod = Array.isArray(query?.method) ? query?.method[0] : query?.method;
  const method = rawMethod === "record" || rawMethod === "upload" || rawMethod === "toy"
    ? rawMethod
    : null;
  return (
    <ReflectionCapture
      forceNew={Array.isArray(newValue) ? newValue[0] === "1" : newValue === "1"}
      method={method}
    />
  );
}
