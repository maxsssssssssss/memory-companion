import { DateCompanionShell } from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";
import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";

export default function DateCompanionModulesPage() {
  return (
    <div className={styles.root}>
      <DateCompanionShell
        dailyReflectionEnabled={isDailyReflectionUploadEnabled()}
        entry="modules"
      />
    </div>
  );
}
