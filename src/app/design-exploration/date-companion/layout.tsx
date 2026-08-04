import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Daily Brief · 静态产品入口探索",
  description: "静态登录、产品空间选择与约会陪伴界面原型。",
  robots: {
    index: false,
    follow: false
  }
};

export default function DateCompanionExplorationLayout({
  children
}: {
  children: ReactNode;
}) {
  return children;
}
