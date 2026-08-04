import { notFound } from "next/navigation";

import {
  DateCompanionShell,
  type DateCompanionScreen
} from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";

const dateCompanionServerScreens: readonly DateCompanionScreen[] = ["home", "person", "recap", "prepare"];

type DateCompanionScreenPageProps = {
  params: Promise<{ screen?: string[] }>;
  searchParams: Promise<{ segment?: string | string[] }>;
};

export default async function DateCompanionScreenPage({ params, searchParams }: DateCompanionScreenPageProps) {
  const route = await params;
  const screenParts = route.screen ?? [];
  if (screenParts.length > 1) notFound();
  const screen = (screenParts[0] ?? "home") as DateCompanionScreen;
  if (!dateCompanionServerScreens.includes(screen)) notFound();

  const query = await searchParams;
  const initialSegmentId = typeof query.segment === "string" && query.segment.trim() ? query.segment : null;

  return (
    <div className={styles.root}>
      <DateCompanionShell entry="companion" initialSegmentId={initialSegmentId} screen={screen} />
    </div>
  );
}
