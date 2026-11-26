import { notFound } from "next/navigation";

import {
  DateCompanionPersistentShell,
  type DateCompanionScreen
} from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";
import { preparationDiscussionFromQuery, safePreparationReturnTo } from "@/lib/domain/date-companion-book-navigation";
import {
  isDailyReflectionUploadEnabled,
  isToySyncEnabled
} from "@/lib/server/daily-reflection/runtime-config";

const dateCompanionServerScreens: readonly DateCompanionScreen[] = ["home", "person", "recap", "prepare", "people"];

type DateCompanionScreenPageProps = {
  params: Promise<{ screen?: string[] }>;
  searchParams: Promise<{
    view?: string | string[];
    from?: string | string[];
    section?: string | string[];
    interaction?: string | string[];
    recording?: string | string[];
    segment?: string | string[];
    preparation?: string | string[];
    draft?: string | string[];
    returnTo?: string | string[];
  }>;
};

export default async function DateCompanionScreenPage({ params, searchParams }: DateCompanionScreenPageProps) {
  const route = await params;
  const screenParts = route.screen ?? [];
  if (screenParts.length > 2 || (screenParts.length === 2 && screenParts[0] !== "people")) notFound();
  const initialPersonId = screenParts.length === 2 && screenParts[0] === "people"
    ? screenParts[1]?.trim() || null
    : null;
  const screen = (initialPersonId ? "person" : screenParts[0] ?? "home") as DateCompanionScreen;
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
        dailyReflectionEnabled={isDailyReflectionUploadEnabled()}
        initialInteractionId={initialInteractionId}
        initialDiscussionId={screen === "prepare" ? preparationDiscussionFromQuery(query.preparation, query.draft) : undefined}
        preparationReturnTo={screen === "recap" ? safePreparationReturnTo(query.returnTo) : null}
        initialRecordingId={screen === "recap" && !initialInteractionId && typeof query.recording === "string" ? query.recording.trim() || null : null}
        initialPersonId={initialPersonId}
        initialSegmentId={initialSegmentId}
        screen={screen}
        showPreparationRecords={screen === "prepare" && (query.section === "records" || query.view === "records")}
        toySyncEnabled={isToySyncEnabled()}
      />
    </div>
  );
}
