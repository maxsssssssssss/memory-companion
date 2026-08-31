"use client";

import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { RegisterInput } from "@/lib/client/date-companion-api";

import styles from "./date-companion.module.css";

export type CompanionAuthMode = "login" | "register";

export type CompanionLoginInput = {
  email: string;
  password: string;
};

type CompanionLoginProps = {
  busy?: boolean;
  errorMessage?: string;
  mode: CompanionAuthMode;
  onLogin: (input: CompanionLoginInput) => Promise<void> | void;
  onModeChange: (mode: CompanionAuthMode) => void;
  onRegister: (input: RegisterInput) => Promise<void> | void;
};

export function CompanionLogin({
  busy = false,
  errorMessage,
  mode,
  onLogin,
  onModeChange,
  onRegister
}: CompanionLoginProps) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const isRegister = mode === "register";
  const isBusy = busy || submitting;
  const errorId = "daily-brief-auth-error";
  const activeTabId = isRegister ? "daily-brief-register-tab" : "daily-brief-login-tab";
  const canSubmit = Boolean(
    email.trim()
    && password
    && (!isRegister || (password.length >= 8 && inviteCode.trim()))
  );

  useEffect(() => {
    if (errorMessage) emailInput.current?.focus();
  }, [errorMessage]);

  const switchMode = (nextMode: CompanionAuthMode) => {
    if (nextMode === mode || isBusy) return;
    setPassword("");
    setInviteCode("");
    setSubmitting(false);
    onModeChange(nextMode);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isBusy) return;
    const tabs = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='tab']");
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const nextMode = isRegister ? "login" : "register";
      switchMode(nextMode);
      tabs[nextMode === "login" ? 0 : 1]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextMode = event.key === "Home" ? "login" : "register";
      switchMode(nextMode);
      tabs[nextMode === "login" ? 0 : 1]?.focus();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || isBusy) return;

    const normalizedEmail = email.trim();
    setSubmitting(true);
    try {
      if (isRegister) {
        const normalizedName = name.trim();
        await onRegister({
          email: normalizedEmail,
          password,
          inviteCode: inviteCode.trim(),
          ...(normalizedName ? { name: normalizedName } : {})
        });
      } else {
        await onLogin({ email: normalizedEmail, password });
      }
    } finally {
      setPassword("");
      setInviteCode("");
      setSubmitting(false);
    }
  };

  return (
    <main
      aria-busy={isBusy}
      aria-labelledby="daily-brief-login-title"
      className={styles.loginRoot}
    >
      <div className={styles.loginAtmosphere} aria-hidden="true">
        <span />
        <span />
      </div>

      <section className={styles.loginBrand}>
        <div className={styles.wordmark}>
          <span className={styles.wordmarkMark}>DB</span>
          <b>Daily Brief</b>
        </div>
        <span className={styles.privateReady}>
          <i aria-hidden="true" />
          一个账号，回到每个私人空间
        </span>
        <h1 id="daily-brief-login-title">登录，回到你的私人空间。</h1>
        <p>约会陪伴与日常复盘都从这里进入，内容仍留在各自的空间里。</p>
      </section>

      <section className={styles.loginStage} aria-label={isRegister ? "注册 Daily Brief" : "登录 Daily Brief"}>
        <div className={styles.loginCard}>
          <div
            aria-label="账号入口"
            className={styles.authModeTabs}
            onKeyDown={handleTabKeyDown}
            role="tablist"
          >
            <button
              aria-controls="daily-brief-auth-panel"
              aria-selected={!isRegister}
              disabled={isBusy}
              id="daily-brief-login-tab"
              onClick={() => switchMode("login")}
              role="tab"
              tabIndex={isRegister ? -1 : 0}
              type="button"
            >登录</button>
            <button
              aria-controls="daily-brief-auth-panel"
              aria-selected={isRegister}
              disabled={isBusy}
              id="daily-brief-register-tab"
              onClick={() => switchMode("register")}
              role="tab"
              tabIndex={isRegister ? 0 : -1}
              type="button"
            >注册</button>
          </div>
          <div
            aria-labelledby={activeTabId}
            className={styles.authModePanel}
            id="daily-brief-auth-panel"
            role="tabpanel"
          >
            <h2>{isRegister ? "创建你的账号" : "欢迎回来"}</h2>
            <p>{isRegister
              ? "创建账号后，直接进入空间选择。"
              : "输入邮箱和密码，继续进入 Daily Brief。"}</p>

            <form className={styles.loginForm} onSubmit={submit}>
              {isRegister ? (
                <label className={styles.field}>
                  昵称（可选）
                  <input
                    autoComplete="name"
                    maxLength={80}
                    name="name"
                    onChange={(event) => setName(event.target.value)}
                    placeholder="想让我们怎么称呼你…"
                    value={name}
                  />
                </label>
              ) : null}
              <label className={styles.field}>
                邮箱
                <input
                  aria-describedby={errorMessage ? errorId : undefined}
                  aria-invalid={errorMessage ? true : undefined}
                  autoComplete="email"
                  inputMode="email"
                  name="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="例如 you@example.com…"
                  ref={emailInput}
                  required
                  spellCheck={false}
                  type="email"
                  value={email}
                />
              </label>
              <label className={styles.field}>
                密码
                <input
                  aria-describedby={errorMessage ? errorId : undefined}
                  aria-invalid={errorMessage ? true : undefined}
                  aria-label="密码"
                  autoComplete={isRegister ? "new-password" : "current-password"}
                  minLength={isRegister ? 8 : undefined}
                  name="password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
                {isRegister ? <small>至少 8 位，仅用于保护你的账号。</small> : null}
              </label>
              {isRegister ? (
                <label className={styles.field}>
                  邀请码
                  <input
                    aria-describedby={errorMessage ? errorId : undefined}
                    aria-invalid={errorMessage ? true : undefined}
                    aria-label="邀请码"
                    autoComplete="off"
                    maxLength={200}
                    name="inviteCode"
                    onChange={(event) => setInviteCode(event.target.value)}
                    placeholder="管理员提供的邀请码…"
                    required
                    spellCheck={false}
                    type="password"
                    value={inviteCode}
                  />
                  <small>邀请码由管理员提供，不会保存在浏览器中。</small>
                </label>
              ) : null}
              {errorMessage ? <p className={styles.loginError} id={errorId} role="alert">{errorMessage}</p> : null}
              <button className={styles.primaryButton} disabled={isBusy || !canSubmit} type="submit">
                <span aria-live="polite">{isBusy ? "正在处理…" : isRegister ? "注册并进入" : "登录"}</span>
                <span aria-hidden="true">→</span>
              </button>
            </form>

            <small className={styles.loginBoundary}>
              {isRegister
                ? "注册成功后会进入空间选择；失败时保留在当前表单。"
                : "你的会话只用于确认账号身份。"}
            </small>
          </div>
        </div>
      </section>
    </main>
  );
}
