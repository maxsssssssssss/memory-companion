"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./work-review.module.css";

const ITEMS = [
  { href: "/work-review/meetings", label: "会议", match: (path: string) => path.startsWith("/work-review/meetings") },
  { href: "/work-review/todos", label: "待办", match: (path: string) => path.startsWith("/work-review/todos") },
  { href: "/work-review/projects", label: "项目", match: (path: string) => path.startsWith("/work-review/projects") },
  { href: "/work-review/weekly", label: "周回顾", match: (path: string) => path.startsWith("/work-review/weekly") }
] as const;

export function WorkReviewNav({ projectsEnabled, todoEnabled, weeklyEnabled }: Readonly<{ projectsEnabled: boolean; todoEnabled: boolean; weeklyEnabled: boolean }>) {
  const pathname = usePathname();
  const items = ITEMS.filter((item) => item.label === "会议"
    || item.label === "待办" && todoEnabled
    || item.label === "项目" && projectsEnabled
    || item.label === "周回顾" && weeklyEnabled);
  return (
    <nav aria-label="工作复盘" className={styles.workReviewNav}>
      {items.map((item) => (
        <Link aria-current={item.match(pathname) ? "page" : undefined} href={item.href} key={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
