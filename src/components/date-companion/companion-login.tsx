"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

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
  const canSubmit = Boolean(
    email.trim()
    && password
    && (!isRegister || (password.length >= 8 && inviteCode.trim()))
  );

  useEffect(() => {
    emailInput.current?.focus();
  }, [mode]);

  const switchMode = (nextMode: CompanionAuthMode) => {
    if (nextMode === mode || isBusy) return;
    setPassword("");
    setInviteCode("");
    setSubmitting(false);
    onModeChange(nextMode);
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
    <main className={styles.loginRoot} aria-labelledby="date-companion-login-title">
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
          只属于你的私人空间
        </span>
        <h1 id="date-companion-login-title">把重要的人和片段，轻轻放在这里。</h1>
        <p>登录后，你可以把一次相处整理成有来源的文字和片段。</p>
      </section>

      <section className={styles.loginStage} aria-label={isRegister ? "注册 Daily Brief" : "登录 Daily Brief"}>
        <div className={styles.loginCard}>
          <p className={styles.eyebrow}>Daily Brief</p>
          <div className={styles.authModeTabs} role="tablist" aria-label="账号入口">
            <button
              aria-controls="date-companion-auth-form"
              aria-selected={!isRegister}
              disabled={isBusy}
              onClick={() => switchMode("login")}
              role="tab"
              type="button"
            >登录</button>
            <button
              aria-controls="date-companion-auth-form"
              aria-selected={isRegister}
              disabled={isBusy}
              onClick={() => switchMode("register")}
              role="tab"
              type="button"
            >注册</button>
          </div>
          <h2>{isRegister ? "创建你的空间" : "欢迎回来"}</h2>
          <p>{isRegister
            ? "使用真实信息创建账号。注册成功后，会直接进入你的私人空间。"
            : "使用你的真实账号进入。认证失败时不会切换到演示身份。"}</p>

          <form className={styles.loginForm} id="date-companion-auth-form" onSubmit={submit}>
            {isRegister ? (
              <label className={styles.field}>
                昵称（可选）
                <input
                  autoComplete="name"
                  maxLength={80}
                  name="name"
                  onChange={(event) => setName(event.target.value)}
                  placeholder="想让我们怎么称呼你"
                  value={name}
                />
              </label>
            ) : null}
            <label className={styles.field}>
              邮箱
              <input
                autoComplete="email"
                inputMode="email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                ref={emailInput}
                required
                type="email"
                value={email}
              />
            </label>
            <label className={styles.field}>
              密码
              <input
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
                  aria-label="邀请码"
                  autoComplete="off"
                  maxLength={200}
                  name="inviteCode"
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="请输入管理员提供的邀请码"
                  required
                  type="password"
                  value={inviteCode}
                />
                <small>邀请码由管理员提供，不会保存在浏览器中。</small>
              </label>
            ) : null}
            {errorMessage ? <p className={styles.loginError} role="alert">{errorMessage}</p> : null}
            <button className={styles.primaryButton} disabled={isBusy || !canSubmit} type="submit">
              <span>{isBusy ? "正在处理…" : isRegister ? "注册并进入" : "登录"}</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <small className={styles.loginBoundary}>
            {isRegister
              ? "注册由真实认证服务完成；失败时不会创建演示身份，也不会自动改为登录。"
              : "登录状态由安全会话保护；认证失败时不会进入任何演示账号。"}
          </small>
        </div>
      </section>
    </main>
  );
}
