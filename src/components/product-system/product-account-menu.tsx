"use client";

import { useState } from "react";

import { ProductAccountPopover } from "./product-account-popover";
import styles from "./product-system.module.css";



export function ProductAccountMenu({
  onLogout,
  showLabel = false,
  paperMotion,
  userLabel
}: Readonly<{
  onLogout: () => Promise<void> | void;
  showLabel?: boolean;
  paperMotion?: boolean;
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

  return <ProductAccountPopover userLabel={userLabel} showLabel={showLabel} paperMotion={paperMotion}>
    {error ? <span className={styles.accountError} role="alert">{error}</span> : null}
    <button disabled={busy} onClick={() => void logout()} type="button">
      <span aria-live="polite">{busy ? "正在退出…" : "退出登录"}</span>
    </button>
  </ProductAccountPopover>;
}
