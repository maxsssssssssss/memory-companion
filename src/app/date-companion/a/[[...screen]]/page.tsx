import { notFound } from "next/navigation";

import {
  DateCompanionPersistentShell,
  type DateCompanionScreen
} from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";
import { isToySyncEnabled } from "@/lib/server/daily-reflection/runtime-config";

const dateCompanionServerScreens: readonly DateCompanionScreen[] = ["home", "person", "recap", "prepare", "people"];

type DateCompanionScreenPageProps = {
  params: Promise<{ screen?: string[] }>;
  searchParams: Promise<{
    interaction?: string | string[];
    segment?: string | string[];
  }>;
};

export default async function DateCompanionScreenPage({ params, searchParams }: DateCompanionScreenPageProps) {
  const route = await params;
  const screenParts = route.screen ?? [];
  if (screenParts.length > 1) notFound();
  const screen = (screenParts[0] ?? "home") as DateCompanionScreen;
  if (!dateCompanionServerScreens.includes(screen)) notFound();

  const query = await searchParams;
  const initialSegmentId = typeof query.segment === "string" && query.segment.trim() ? query.segment : null;
  const initialInteractionId = typeof query.interaction === "string" && query.interaction.trim()
    ? query.interaction
    : null;

  return (
    <div className={styles.root}>
      <DateCompanionPersistentShell
        entry="companion"
        initialInteractionId={initialInteractionId}
        initialSegmentId={initialSegmentId}
        screen={screen}
        toySyncEnabled={isToySyncEnabled()}
      />
    </div>
  );
}
