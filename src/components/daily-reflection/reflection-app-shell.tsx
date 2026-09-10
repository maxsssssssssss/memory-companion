"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef
} from "react";

import { DailyReflectionApiError } from "@/lib/client/daily-reflection-api";
import { ProductAccountMenu } from "@/components/product-system/product-account-menu";
import { ProductState } from "@/components/product-system/product-primitives";
import { ProductSwitcher } from "@/components/product-system/product-switcher";
import { createDailyReflectionThinkingApi } from "@/lib/client/daily-reflection-thinking-api";
import type { DailyReflectionAiReviewApi } from "@/lib/client/daily-reflection-ai-review-api";
import {
  useDailyReflectionSession,
  type DailyReflectionSessionValue
} from "@/lib/client/daily-reflection-session";

import styles from "./daily-reflection.module.css";
import { armVoiceAutostartIntent } from "./reflection-capture-intent";
import {
  ReflectionThinkingProvider,
  ReflectionThinkingQuickPanel,
  useReflectionThinking
} from "./reflection-thinking-panel";
import {
  ReflectionAiReviewProvider,
  useReflectionAiReview
} from "./reflection-ai-review-provider";
import {
  REFLECTION_DESKTOP_NAV,
  REFLECTION_MOBILE_NAV,
  REFLECTION_ROUTES,
  reflectionRouteIsActive
} from "./reflection-product";

type ReflectionAppContextValue = Readonly<{
  browserRecordingEnabled: boolean;
  handleApiError(error: unknown): boolean;
  session: DailyReflectionSessionValue;
  toySyncEnabled: boolean;
}>;

const ReflectionAppContext = createContext<ReflectionAppContextValue | null>(null);
const THINKING_API = createDailyReflectionThinkingApi();

export function useReflectionApp() {
  const value = useContext(ReflectionAppContext);
  if (!value) throw new Error("ReflectionAppShell is required");
  return value;
}

type ReflectionAppShellProps = Readonly<{
  aiReviewApi?: DailyReflectionAiReviewApi;
  browserRecordingEnabled: boolean;
  children: ReactNode;
  toySyncEnabled: boolean;
}>;

function ReflectionThinkingShellActions() {
  const { openPanel } = useReflectionThinking();
  return (
    <button
      className={styles.reflectionBrainstormButton}
      onClick={(event) => openPanel(event.currentTarget)}
      type="button"
    >
      头脑风暴
    </button>
  );
}

function ReflectionAiReviewNavLabel({ label }: Readonly<{ label: string }>) {
  const { summary } = useReflectionAiReview();
  const count = summary?.exposureMode === "on" ? summary.unseenReadyCount : 0;
  return <>
    <span>{label}</span>
    {label === "回看" && count > 0 ? <>
      <span aria-hidden="true" className={styles.aiReviewUnreadDot} />
      <span className={styles.visuallyHidden}>{count} 份 AI 深度回看已完成</span>
    </> : null}
  </>;
}

function ReflectionAiReviewCompletionNotice() {
  const { completionNotice, dismissCompletionNotice } = useReflectionAiReview();
  if (!completionNotice) return null;
  const scopeLabel = completionNotice.scope === "weekly" ? "本周" : "今天";
  return (
    <aside aria-live="polite" className={styles.aiReviewCompletionNotice} role="status">
      <div>
        <strong>{scopeLabel}的 AI 深度回看已完成</strong>
        <span>规则回看仍然保留，你可以随时核对来源。</span>
      </div>
      <Link href="/reflection/reflect" onClick={dismissCompletionNotice}>去看看</Link>
      <button aria-label="关闭 AI 深度回看完成提示" onClick={dismissCompletionNotice} type="button">×</button>
    </aside>
  );
}

function focusedRoute(pathname: string) {
  if (pathname === REFLECTION_ROUTES.capture) {
    return { backHref: REFLECTION_ROUTES.home, label: "开始讲述" };
  }
  if (pathname.startsWith("/reflection/sessions/")) {
    return { backHref: REFLECTION_ROUTES.home, label: "本次复盘" };
  }
  if (pathname !== REFLECTION_ROUTES.cards && pathname.startsWith(`${REFLECTION_ROUTES.cards}/`)) {
    return { backHref: REFLECTION_ROUTES.cards, label: "卡片" };
  }
  if (pathname === REFLECTION_ROUTES.memory) {
    return { backHref: REFLECTION_ROUTES.home, label: "记忆" };
  }
  if (pathname.startsWith(`${REFLECTION_ROUTES.memory}/`)) {
    return { backHref: REFLECTION_ROUTES.memory, label: "记忆详情" };
  }
  return null;
}

export function ReflectionAppShell({
  aiReviewApi,
  browserRecordingEnabled,
  children,
  toySyncEnabled
}: ReflectionAppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useDailyReflectionSession({ retainAcrossNavigation: true });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    if (session.auth.status === "anonymous") router.replace("/date-companion");
  }, [router, session.auth.status]);

  const handleApiError = useCallback((error: unknown) => {
    if (!(error instanceof DailyReflectionApiError) || error.status !== 401) return false;
    void sessionRef.current.initialize();
    router.replace("/date-companion");
    return true;
  }, [router]);

  const context = useMemo<ReflectionAppContextValue>(() => ({
    browserRecordingEnabled,
    handleApiError,
    session,
    toySyncEnabled
  }), [browserRecordingEnabled, handleApiError, session, toySyncEnabled]);

  if (session.auth.status === "checking" || session.auth.status === "anonymous") {
    return (
      <main className={styles.reflectionBoundary}>
        <div className={styles.reflectionBoundaryState}>
          <ProductState
            title={session.auth.status === "checking"
              ? "正在打开你的日常复盘…"
              : "正在返回登录页…"}
            tone="loading"
          />
        </div>
      </main>
    );
  }

  if (session.auth.status === "error") {
    return (
      <main className={styles.reflectionBoundary}>
        <div className={styles.reflectionBoundaryState}>
          <ProductState
            action={<button onClick={() => void session.initialize()} type="button">重新尝试</button>}
            description={session.auth.message}
            title="暂时无法进入"
            tone="error"
          />
        </div>
      </main>
    );
  }

  const userLabel = session.auth.user.name?.trim() || session.auth.user.email;
  const focused = focusedRoute(pathname);

  return (
    <ReflectionAppContext.Provider value={context}>
      <ReflectionAiReviewProvider accountId={session.auth.user.id} api={aiReviewApi} key={session.auth.user.id}>
        <ReflectionThinkingProvider api={THINKING_API}>
        <div className={`${styles.reflectionApp} ${focused ? styles.reflectionFocusedFlow : styles.reflectionRootFlow}`}>
        <header className={styles.reflectionHeader}>
          <Link className={styles.reflectionBrand} href={REFLECTION_ROUTES.home} aria-label="回到日常复盘首页">
            <span aria-hidden="true">DB</span>
            <div><b>Daily Reflection</b><small>把重要的想法留给未来</small></div>
          </Link>
          <nav className={styles.reflectionDesktopNav} aria-label="日常复盘主导航">
            {REFLECTION_DESKTOP_NAV.map((item) => {
              const active = reflectionRouteIsActive(pathname, item);
              return (
                <Link aria-current={active ? "page" : undefined} className={active ? styles.reflectionNavActive : undefined} href={item.href} key={item.href}>
                  <ReflectionAiReviewNavLabel label={item.label} />
                </Link>
              );
            })}
          </nav>
          <div className={styles.reflectionAccount}>
            <ProductSwitcher accountId={session.auth.user.id} currentProduct="daily_reflection" />
            <ReflectionThinkingShellActions />
            <Link
              className={styles.reflectionCaptureButton}
              href={`${REFLECTION_ROUTES.capture}?new=1&method=record`}
              onClick={() => armVoiceAutostartIntent()}
            >
              <span aria-hidden="true">＋</span>开始讲述
            </Link>
            <ProductAccountMenu
              onLogout={async () => {
                await session.logout();
                router.replace("/date-companion");
              }}
              userLabel={userLabel}
            />
          </div>
        </header>
        <ReflectionThinkingQuickPanel />
        <ReflectionAiReviewCompletionNotice />

        {focused ? (
          <div aria-label="当前页面导航" className={styles.reflectionFocusedHeader} role="navigation">
            <Link href={focused.backHref} aria-label={`返回${focused.label === "开始讲述" ? "今天" : focused.label}`}>
              <span aria-hidden="true">←</span>
              <span>返回</span>
            </Link>
            <b>{focused.label}</b>
            <span aria-hidden="true" />
          </div>
        ) : null}

        <div className={styles.reflectionShellContent}>{children}</div>

        {!focused ? <nav className={styles.reflectionMobileNav} aria-label="日常复盘移动导航">
          {REFLECTION_MOBILE_NAV.map((item) => {
            const active = reflectionRouteIsActive(pathname, item);
            const primary = "primary" in item && item.primary;
            const href = primary ? `${item.href}?new=1&method=record` : item.href;
            return (
              <Link
                aria-label={primary ? "开始讲述" : undefined}
                aria-current={active ? "page" : undefined}
                className={primary ? styles.reflectionMobilePrimary : active ? styles.reflectionNavActive : undefined}
                href={href}
                key={item.href}
                onClick={primary ? () => armVoiceAutostartIntent() : undefined}
              >
                <span aria-hidden="true">{item.icon}</span>
                <small><ReflectionAiReviewNavLabel label={item.label} /></small>
              </Link>
            );
          })}
        </nav> : null}
        </div>
        </ReflectionThinkingProvider>
      </ReflectionAiReviewProvider>
    </ReflectionAppContext.Provider>
  );
}
