"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  createDateCompanionApi,
  type DateCompanionApi
} from "@/lib/client/date-companion-api";

import { GlobalProductEntry } from "./global-product-entry";
import { ProductState } from "./product-primitives";
import styles from "./product-system.module.css";

type GlobalEntryAuthApi = Pick<DateCompanionApi, "getCurrentUser" | "logout">;
type AuthUser = NonNullable<Awaited<ReturnType<DateCompanionApi["getCurrentUser"]>>>;
type AuthState =
  | { status: "checking" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "anonymous" }
  | { status: "error" };

export function GlobalProductEntryBoundary({
  api,
  dailyReflectionEnabled,
  workReviewEnabled
}: Readonly<{
  api?: GlobalEntryAuthApi;
  dailyReflectionEnabled: boolean;
  workReviewEnabled: boolean;
}>) {
  const router = useRouter();
  const authApi = useMemo(() => api ?? createDateCompanionApi(), [api]);
  const [auth, setAuth] = useState<AuthState>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setAuth({ status: "checking" });
    void authApi.getCurrentUser(controller.signal).then((user) => {
      if (controller.signal.aborted) return;
      if (!user) {
        setAuth({ status: "anonymous" });
        router.replace("/date-companion");
        return;
      }
      setAuth({ status: "authenticated", user });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setAuth({ status: "error" });
    });
    return () => controller.abort();
  }, [attempt, authApi, router]);

  if (auth.status !== "authenticated") {
    const error = auth.status === "error";
    return (
      <main className={styles.globalEntry}>
        <div className={styles.globalEntryStatus}>
          <ProductState
            action={error ? (
              <button onClick={() => setAttempt((value) => value + 1)} type="button">重新尝试</button>
            ) : undefined}
            description={error ? "请检查网络后再试。" : undefined}
            title={error ? "暂时无法进入" : auth.status === "anonymous" ? "正在返回登录页…" : "正在进入…"}
            tone={error ? "error" : "loading"}
          />
        </div>
      </main>
    );
  }

  const userLabel = auth.user.name?.trim() || auth.user.email;
  return (
    <GlobalProductEntry
      accountId={auth.user.id}
      dailyReflectionEnabled={dailyReflectionEnabled}
      onLogout={async () => {
        await authApi.logout();
        router.replace("/date-companion");
      }}
      userLabel={userLabel}
      workReviewEnabled={workReviewEnabled}
    />
  );
}
