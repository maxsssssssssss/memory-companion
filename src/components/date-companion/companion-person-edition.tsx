"use client";

import Link from "next/link";
import type { DateCompanionPersonArchiveState } from "@/lib/client/date-companion-people";
import type { DateCompanionSessionValue } from "@/lib/client/date-companion-session";
import { bookPersonHref } from "@/lib/domain/date-companion-book-navigation";
import { CompanionPeople } from "./companion-people";
import { PersonRecordControls } from "./companion-person-record-controls";
import { bookMeetingTitle } from "./book-recap";
import { CompanionPersonScrapbook, PersonScrapbookLoading } from "./companion-person-scrapbook";
import styles from "./companion-person-edition.module.css";

type Props = {
  session: DateCompanionSessionValue;
  accountId: string;
  relationshipId: string;
  screen: "people" | "person";
  personId: string | null;
  currentPersonId: string | null;
  section: string | null;
  archiveState: DateCompanionPersonArchiveState;
  retryArchive(): void;
};

export function CompanionPersonEdition({ session, accountId, relationshipId, screen, personId,
  currentPersonId, section, archiveState, retryArchive }: Props) {
  const directory = bookPersonHref(null, "directory");
  const forCurrent = personId !== null && personId === currentPersonId;
  const page = screen === "person" && personId ? bookPersonHref(personId) : directory;
  const meetingHref = (id: string) => "/date-companion/a/recap?" + new URLSearchParams({
    interaction: id
  });
  const managementHref = (kind: "people" | "privacy" | "records") => kind === "records" && forCurrent
    ? bookPersonHref(personId, "records") : bookPersonHref(null, "manage") + (kind === "privacy" ? "#retention-title" : "#people-mapping-title");

  if (section === "manage" && screen === "people") return (
    <section className={styles.controls}>
      <Link href={directory}>← 全部人物</Link>
      <h1>人物与数据设置</h1>
      <CompanionPeople titleForRecord={id => {
        const record = session.viewModel.recap.history.find(item => item.relationshipInteractionId === id && item.sourceState !== "explicitly_deleted");
        return record ? bookMeetingTitle(record) : null;
      }} state={session.memoryBridgeState} mutationState={session.memoryMutationState}
        onCreatePerson={session.createConfirmedPerson} onSaveMapping={session.savePersonMapping}
        onSetRetention={session.setLongTermRetention} onPreviewWithdrawal={session.previewRetainedMemory} onPurge={session.purgeRetainedMemory}
        onRetry={session.syncInteractionMemory} onRefresh={() => session.ensureMemoryBridgeLoaded(true)}
        hrefFor={raw => {
          const url = new URL(raw, "http://localhost");
          if (url.pathname.endsWith("/recap")) return meetingHref(url.searchParams.get("interaction") ?? "");
          if (url.pathname === "/date-companion/a") return url.pathname;
          return directory;
        }} />
    </section>
  );
  if (forCurrent && section === "records") {
    // Managing a saved meeting has the same scope as reopening it. The
    // person's long-term material projection omits recap-only meetings.
    const records = session.viewModel.recap.history;
    return <section className={styles.controls}>
      <Link href={page}>← 返回人物</Link><h1>管理相处记录</h1>
      {records.length ? <PersonRecordControls open confirmedInteractions={records} titleFor={bookMeetingTitle} mutationState={session.mutationState}
        onDeleteInteraction={async record => {
          if (record.relationshipInteractionId) await session.deleteInteraction(record.relationshipInteractionId);
        }} /> : <p>还没有可管理的已保存记录。</p>}
    </section>;
  }
  return <CompanionPersonScrapbook screen={screen} session={session} accountId={accountId}
    relationshipId={relationshipId} personId={personId} archiveState={archiveState}
    onRetryArchive={retryArchive} directoryHref={directory} personHref={bookPersonHref}
    managementHref={managementHref} meetingHref={meetingHref} />;
}

export function PersonEditionReading({ error, retry }: {error?: string; retry?: () => void}) {
  if (!error) return <PersonScrapbookLoading />;
  return <section className={styles.controls} role="alert">
    <h2>人物资料暂时无法读取</h2><p>{error}</p><button type="button" onClick={retry}>重新读取</button>
  </section>;
}
