"use client";

import Link from "next/link";

import { LocalTimeGreeting } from "./local-time-greeting";

import styles from "./date-companion.module.css";

type CompanionModulesProps = {
  userLabel: string;
  onLogout: () => Promise<void> | void;
};

export function CompanionModules({ userLabel, onLogout }: CompanionModulesProps) {
  return (
    <main className={styles.modulePage}>
      <header className={styles.moduleHeader}>
        <Link className={styles.wordmark} href="/date-companion/modules" aria-label="Daily Brief 模块选择">
          <span className={styles.wordmarkMark}>DB</span>
          <b>Daily Brief</b>
        </Link>
        <div className={styles.userTools}>
          <span title={userLabel}>{userLabel}</span>
          <button className={styles.quietButton} onClick={() => void onLogout()} type="button">退出</button>
        </div>
      </header>

      <section className={styles.moduleIntro}>
        <LocalTimeGreeting className={styles.localGreeting} />
        <h1>今天，你想从哪里开始？</h1>
        <span>先选择一个空间。第一版只开放约会陪伴。</span>
      </section>

      <section className={styles.moduleGrid} aria-label="产品空间">
        <Link className={`${styles.moduleCard} ${styles.dateModule}`} href="/date-companion/a">
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">相</span>
            <span className={styles.availableBadge}>现在可用</span>
          </div>
          <div className={styles.moduleCopy}>
            <p>FOR TWO</p>
            <h2>约会陪伴</h2>
            <span>记录一次相处，查看有来源的复盘，也可以只针对这次相处提问。</span>
          </div>
          <div className={styles.moduleMeta}>
            <span>上传长录音 · 查看文字稿 · 问问这次相处</span>
            <b><span>进入约会陪伴</span><span aria-hidden="true">↗</span></b>
          </div>
        </Link>

        <article className={`${styles.moduleCard} ${styles.officeModule} ${styles.disabledModule}`} aria-disabled="true">
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">复</span>
            <span className={styles.developmentBadge}>开发中</span>
          </div>
          <div className={styles.moduleCopy}>
            <p>FOR WORK</p>
            <h2>办公复盘</h2>
            <span>工作沟通的连续复盘仍在设计中，本轮不会连接后端。</span>
          </div>
          <div className={styles.moduleMeta}><span>暂不可进入</span><b>开发中</b></div>
        </article>

        <article className={`${styles.moduleCard} ${styles.chatModule} ${styles.disabledModule}`} aria-disabled="true">
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">聊</span>
            <span className={styles.developmentBadge}>开发中</span>
          </div>
          <div className={styles.moduleCopy}>
            <p>FOR EVERYDAY</p>
            <h2>日常闲聊</h2>
            <span>轻量日常对话仍在设计中，本轮不会连接后端。</span>
          </div>
          <div className={styles.moduleMeta}><span>暂不可进入</span><b>开发中</b></div>
        </article>
      </section>

      <footer className={styles.moduleFooter}>当前候选入口不会加入正式导航。</footer>
    </main>
  );
}
