"use client";

import { useState } from "react";

import { ProductPopover } from "./product-popover";
import styles from "./product-system.module.css";

function accountInitial(label: string) {
  return label.trim().slice(0, 1).toUpperCase() || "我";
}

export function ProductAccountMenu({
  onLogout,
  showLabel = false,
  userLabel
}: Readonly<{
  onLogout: () => Promise<void> | void;
  showLabel?: boolean;
  userLabel: string;
}>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogout();
    } catch {
      setError("暂时无法退出，请再试一次。");
      setBusy(false);
    }
  };

  return (
    <ProductPopover
      className={styles.accountPopover}
      label={`账号菜单，当前账号${userLabel}`}
      panelClassName={styles.accountMenu}
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
      {error ? <span className={styles.accountError} role="alert">{error}</span> : null}
      <button disabled={busy} onClick={() => void logout()} type="button">
        <span aria-live="polite">{busy ? "正在退出…" : "退出登录"}</span>
      </button>
    </ProductPopover>
  );
}
