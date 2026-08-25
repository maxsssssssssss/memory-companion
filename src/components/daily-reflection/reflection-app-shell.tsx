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
import {
  useDailyReflectionSession,
  type DailyReflectionSessionValue
} from "@/lib/client/daily-reflection-session";

import styles from "./daily-reflection.module.css";
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

export function useReflectionApp() {
  const value = useContext(ReflectionAppContext);
  if (!value) throw new Error("ReflectionAppShell is required");
  return value;
}

type ReflectionAppShellProps = Readonly<{
  browserRecordingEnabled: boolean;
  children: ReactNode;
  toySyncEnabled: boolean;
}>;

function focusedRoute(pathname: string) {
  if (pathname === REFLECTION_ROUTES.capture) {
    return { backHref: REFLECTION_ROUTES.home, label: "开始表达" };
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
  browserRecordingEnabled,
  children,
  toySyncEnabled
}: ReflectionAppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useDailyReflectionSession();
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
        <div className={styles.loadingCard} role="status">
          <span className={styles.loadingDot} aria-hidden="true" />
          <p>{session.auth.status === "checking"
            ? "正在打开你的日常复盘…"
            : "正在返回登录页…"}</p>
        </div>
      </main>
    );
  }

  if (session.auth.status === "error") {
    return (
      <main className={styles.reflectionBoundary}>
        <div className={styles.loadingCard}>
          <p className={styles.eyebrow}>日常复盘</p>
          <h1>暂时无法进入</h1>
          <p className={styles.inlineError} role="alert">{session.auth.message}</p>
          <button className={styles.primaryButton} onClick={() => void session.initialize()} type="button">
            重新尝试
          </button>
        </div>
      </main>
    );
  }

  const userLabel = session.auth.user.name?.trim() || session.auth.user.email;
  const focused = focusedRoute(pathname);

  return (
    <ReflectionAppContext.Provider value={context}>
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
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className={styles.reflectionAccount}>
            <Link className={styles.reflectionCaptureButton} href={`${REFLECTION_ROUTES.capture}?new=1`}>
              <span aria-hidden="true">＋</span>开始表达
            </Link>
            <details>
              <summary aria-label={`账号：${userLabel}`}>{userLabel.slice(0, 1).toUpperCase()}</summary>
              <div>
                <span title={userLabel}>{userLabel}</span>
                <button onClick={async () => {
                  await session.logout();
                  router.replace("/date-companion");
                }} type="button">退出登录</button>
              </div>
            </details>
          </div>
        </header>

        {focused ? (
          <div aria-label="当前页面导航" className={styles.reflectionFocusedHeader} role="navigation">
            <Link href={focused.backHref} aria-label={`返回${focused.label === "开始表达" ? "今天" : focused.label}`}>
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
            const href = primary ? `${item.href}?new=1` : item.href;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={primary ? styles.reflectionMobilePrimary : active ? styles.reflectionNavActive : undefined}
                href={href}
                key={item.href}
              >
                <span aria-hidden="true">{item.icon}</span>
                <small>{item.label}</small>
              </Link>
            );
          })}
        </nav> : null}
      </div>
    </ReflectionAppContext.Provider>
  );
}
