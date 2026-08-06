"use client";

import { type FormEvent, useState } from "react";

import styles from "./date-companion.module.css";

export type CompanionLoginInput = {
  email: string;
  password: string;
};

type CompanionLoginProps = {
  busy?: boolean;
  errorMessage?: string;
  onLogin: (input: CompanionLoginInput) => Promise<void> | void;
};

export function CompanionLogin({ busy = false, errorMessage, onLogin }: CompanionLoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password || busy) return;
    void onLogin({ email: normalizedEmail, password });
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

      <section className={styles.loginStage} aria-label="登录 Daily Brief">
        <div className={styles.loginCard}>
          <p className={styles.eyebrow}>Daily Brief</p>
          <h2>欢迎回来</h2>
          <p>使用你的真实账号进入。认证失败时不会切换到演示身份。</p>

          <form className={styles.loginForm} onSubmit={submit}>
            <label className={styles.field}>
              邮箱
              <input
                autoComplete="email"
                inputMode="email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={email}
              />
            </label>
            <label className={styles.field}>
              密码
              <input
                autoComplete="current-password"
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </label>
            {errorMessage ? <p className={styles.loginError} role="alert">{errorMessage}</p> : null}
            <button className={styles.primaryButton} disabled={busy || !email.trim() || !password} type="submit">
              <span>{busy ? "正在登录…" : "登录"}</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>

          <small className={styles.loginBoundary}>登录状态由安全会话保护；认证失败时不会进入任何演示账号。</small>
        </div>
      </section>
    </main>
  );
}
