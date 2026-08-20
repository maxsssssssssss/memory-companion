import { DateCompanionShell } from "@/components/date-companion/date-companion-shell";
import styles from "@/components/date-companion/date-companion.module.css";

export default function DateCompanionLoginPage() {
  return <div className={styles.root}><DateCompanionShell entry="login" /></div>;
}
