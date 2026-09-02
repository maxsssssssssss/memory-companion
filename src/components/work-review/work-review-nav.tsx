"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./work-review.module.css";

const ITEMS = [
  { href: "/work-review", label: "今天", match: (path: string) => path === "/work-review" },
  { href: "/work-review/todos", label: "待办", match: (path: string) => path.startsWith("/work-review/todos") },
  { href: "/work-review/meetings", label: "会议", match: (path: string) => path.startsWith("/work-review/meetings") }
] as const;

export function WorkReviewNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="工作复盘" className={styles.workReviewNav}>
      {ITEMS.map((item) => (
        <Link aria-current={item.match(pathname) ? "page" : undefined} href={item.href} key={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
