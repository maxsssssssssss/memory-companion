import type { ReactNode } from "react";
import { ProductPopover } from "./product-popover";
import styles from "./product-system.module.css";

function accountInitial(label: string) {
  return label.trim().slice(0, 1).toUpperCase() || "我";
}

export function ProductAccountPopover({
  userLabel, showLabel = false, children, paperMotion
}: Readonly<{
  userLabel: string;
  showLabel?: boolean;
  paperMotion?: boolean;
  children: ReactNode;
}>) {
  return (
    <ProductPopover
      className={styles.accountPopover}
      label={`账号菜单，当前账号${userLabel}`}
      panelClassName={styles.accountMenu}
      paperMotion={paperMotion}
      trigger={(
        <>
          <span aria-hidden="true" className={styles.accountInitial}>{accountInitial(userLabel)}</span>
          {showLabel ? <span className={styles.accountTriggerLabel}>{userLabel}</span> : null}
          <span aria-hidden="true" className={styles.accountChevron}>⌄</span>
        </>
      )}
      triggerClassName={styles.accountTrigger}
    >
      <p>账号</p>
      <strong title={userLabel}>{userLabel}</strong>
      {children}
    </ProductPopover>
  );
}
