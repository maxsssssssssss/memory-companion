import { DateCompanionShell } from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";

export default function DateCompanionModulesPage() {
  return <div className={styles.root}><DateCompanionShell entry="modules" /></div>;
}
