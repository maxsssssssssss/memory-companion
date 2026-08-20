import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "约会陪伴 · Daily Brief",
  description: "记录重要相处、回看关于 Ta 的片段，并为下次见面做轻量准备。"
};

export default function DateCompanionLayout({ children }: { children: ReactNode }) {
  return children;
}
