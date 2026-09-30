"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createDateCompanionApi } from "@/lib/client/date-companion-api";
import { ProductAccountMenu } from "@/components/product-system/product-account-menu";
import { ProductSwitcher } from "@/components/product-system/product-switcher";
import { ProductState } from "@/components/product-system/product-primitives";
import styles from "./learning.module.css";
import { LearningReadingAccount } from "./learning-reading-state";

export function LearningShell({ children, dailyReflectionEnabled }: { children: ReactNode; dailyReflectionEnabled: boolean }) {
  const router = useRouter();
  const api = useMemo(() => createDateCompanionApi(), []);
  const [user, setUser] = useState<Awaited<ReturnType<typeof api.getCurrentUser>>>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let latest = 0;
    const check = async () => {
      const ticket = ++latest;
      try {
        const result = await api.getCurrentUser(controller.signal);
        if (controller.signal.aborted || ticket !== latest) return;
        setUser(result);
        setError(false);
        if (!result) router.replace("/date-companion");
      } catch {
        if (!controller.signal.aborted && ticket === latest) setError(true);
      }
    };
    void check();
    window.addEventListener("focus", check);
    return () => { controller.abort(); window.removeEventListener("focus", check); };
  }, [api, attempt, router]);
  return (
    <div className={styles.app}>
      {user ? <Fragment key={user.id}>
        <header className={styles.shellHeader}>
          <div className={styles.row}>
            <ProductSwitcher accountId={user.id} currentProduct="learning_organizer" dailyReflectionEnabled={dailyReflectionEnabled} />
            <span className={styles.badge}>试用中</span>
          </div>
          <ProductAccountMenu userLabel={user.name || user.email} onLogout={async () => {
            await api.logout(); setUser(null); router.replace("/date-companion");
          }} />
        </header>
        <main className={styles.main}>
          {error ? <p role="alert">暂时无法刷新登录状态，待保存材料仍在当前页。请检查网络后重试。</p> : null}
          <nav aria-label="学习整理导航"><Link href="/learning">我的学习页</Link></nav>
          <LearningReadingAccount.Provider value={user.id}>{children}</LearningReadingAccount.Provider>
        </main>
      </Fragment> : <main className={styles.main}>
        <ProductState title={error ? "暂时无法确认登录状态" : "正在进入学习整理…"} tone={error ? "error" : "loading"}
          action={error ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button> : undefined} />
      </main>}
    </div>
  );
}
