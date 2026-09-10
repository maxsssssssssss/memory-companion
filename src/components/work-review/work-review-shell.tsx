"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";

import { ProductAccountMenu } from "@/components/product-system/product-account-menu";
import { ProductState } from "@/components/product-system/product-primitives";
import { ProductSwitcher } from "@/components/product-system/product-switcher";
import {
  createWorkReviewApi,
  type WorkReviewApi,
  type WorkReviewCapabilities,
  type WorkReviewAuthUser
} from "@/lib/client/work-review-api";

import styles from "./work-review.module.css";
import { WorkReviewNav } from "./work-review-nav";
import { DISABLED_WORK_REVIEW_CAPABILITIES } from "./work-review-v2";

export type WorkReviewFeatureFlags = Readonly<{
  analysisEnabled: boolean;
  followUpEnabled: boolean;
  todoEnabled: boolean;
  todoMeetingProjectionEnabled: boolean;
  uploadEnabled: boolean;
  verifierEnabled: boolean;
}>;

type WorkReviewContextValue = Readonly<{
  api: WorkReviewApi;
  capabilities: WorkReviewCapabilities;
  capabilitiesStatus: "loading" | "ready" | "error";
  featureFlags: WorkReviewFeatureFlags;
  refreshCapabilities: () => void;
  user: WorkReviewAuthUser;
}>;

export const WorkReviewContext = createContext<WorkReviewContextValue | null>(null);

export function useWorkReview() {
  const value = useContext(WorkReviewContext);
  if (!value) throw new Error("WorkReviewShell is required");
  return value;
}

export function WorkReviewShell({
  analysisEnabled,
  api,
  children,
  dailyReflectionEnabled,
  followUpEnabled,
  todoEnabled,
  todoMeetingProjectionEnabled,
  uploadEnabled,
  verifierEnabled
}: Readonly<WorkReviewFeatureFlags & {
  api?: WorkReviewApi;
  children: ReactNode;
  dailyReflectionEnabled: boolean;
}>) {
  const router = useRouter();
  const client = useMemo(() => api ?? createWorkReviewApi(), [api]);
  const [auth, setAuth] = useState<
    | { status: "checking" }
    | { status: "authenticated"; user: WorkReviewAuthUser }
    | { status: "anonymous" }
    | { status: "error" }
  >({ status: "checking" });
  const [attempt, setAttempt] = useState(0);
  const [capabilities, setCapabilities] = useState<WorkReviewCapabilities>(
    DISABLED_WORK_REVIEW_CAPABILITIES
  );
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [capabilitiesAttempt, setCapabilitiesAttempt] = useState(0);
  const refreshCapabilities = useCallback(() => {
    setCapabilitiesAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setAuth({ status: "checking" });
    void client.getCurrentUser(controller.signal).then((user) => {
      if (controller.signal.aborted) return;
      if (!user) {
        setAuth({ status: "anonymous" });
        router.replace("/date-companion");
        return;
      }
      setAuth({ status: "authenticated", user });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setAuth({ status: "error" });
    });
    return () => controller.abort();
  }, [attempt, client, router]);

  useEffect(() => {
    const controller = new AbortController();
    setCapabilities(DISABLED_WORK_REVIEW_CAPABILITIES);
    if (auth.status !== "authenticated") {
      setCapabilitiesStatus("loading");
      return () => controller.abort();
    }
    if (!client.getCapabilities) {
      setCapabilitiesStatus("ready");
      return () => controller.abort();
    }
    setCapabilitiesStatus("loading");
    void client.getCapabilities(controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setCapabilities(next);
      setCapabilitiesStatus("ready");
    }).catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return;
      setCapabilities(DISABLED_WORK_REVIEW_CAPABILITIES);
      setCapabilitiesStatus("error");
    });
    return () => controller.abort();
  }, [auth.status, capabilitiesAttempt, client]);

  if (auth.status !== "authenticated") {
    const failed = auth.status === "error";
    return (
      <div className={styles.app}>
        <main className={styles.centeredState}>
          <ProductState
            action={failed ? (
              <button className={styles.secondaryButton} onClick={() => setAttempt((value) => value + 1)} type="button">
                重新尝试
              </button>
            ) : undefined}
            description={failed ? "请检查网络后再试。" : undefined}
            title={failed ? "暂时无法进入工作复盘" : auth.status === "anonymous" ? "正在返回登录页…" : "正在进入工作复盘…"}
            tone={failed ? "error" : "loading"}
          />
        </main>
      </div>
    );
  }

  const featureFlags = {
    analysisEnabled,
    followUpEnabled,
    todoEnabled,
    todoMeetingProjectionEnabled,
    uploadEnabled,
    verifierEnabled
  };
  const userLabel = auth.user.name?.trim() || auth.user.email;
  return (
    <WorkReviewContext.Provider value={{
      api: client,
      capabilities,
      capabilitiesStatus,
      featureFlags,
      refreshCapabilities,
      user: auth.user
    }}>
      <div className={styles.app}>
        <header className={styles.topBar}>
          <ProductSwitcher
            accountId={auth.user.id}
            currentProduct="office_review"
            dailyReflectionEnabled={dailyReflectionEnabled}
            workReviewEnabled
          />
          <div className={styles.topBarTools}>
            <span>工作复盘 · 私密会议整理</span>
            <ProductAccountMenu
              onLogout={async () => {
                await client.logout();
                router.replace("/date-companion");
              }}
              userLabel={userLabel}
            />
          </div>
        </header>
        <WorkReviewNav projectsEnabled={capabilities.projects} todoEnabled={todoEnabled} weeklyEnabled={capabilities.weekly} />
        {children}
      </div>
    </WorkReviewContext.Provider>
  );
}
