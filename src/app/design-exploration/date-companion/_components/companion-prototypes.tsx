import type { ReactNode } from "react";
import Link from "next/link";

import { ExpandableProfileFacts } from "./expandable-profile-facts";
import styles from "./exploration.module.css";
import { LocalTimeGreeting } from "./local-time-greeting";
import { RelationshipHistory } from "./relationship-history";
import { RelationshipSearch } from "./relationship-search";
import { StaticRecapReview } from "./static-recap-review";
import { StaticQuestionDrawer } from "./static-question-drawer";

export const prototypeScreens = ["home", "person", "recap", "prepare"] as const;

export type PrototypeScreen = (typeof prototypeScreens)[number];

const basePath = "/design-exploration/date-companion";
const modulesPath = `${basePath}/modules`;

export function isPrototypeScreen(value: string): value is PrototypeScreen {
  return prototypeScreens.includes(value as PrototypeScreen);
}

function prototypePath(screen: PrototypeScreen = "home") {
  return screen === "home" ? `${basePath}/a` : `${basePath}/a/${screen}`;
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Avatar({ name }: { name: string }) {
  return (
    <span className={`${styles.avatar} ${styles.avatar_large}`} aria-hidden="true">
      {name.slice(-1)}
    </span>
  );
}

export function CompanionLogin() {
  return (
    <main
      className={styles.entryRoot}
      data-entry-screen="login"
      data-exploration-layout="desktop-first"
    >
      <div className={styles.entryAtmosphere} aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <section className={styles.entryBrand} aria-labelledby="entry-title">
        <div className={styles.entryWordmark}>
          <span>DB</span>
          <b>Daily Brief</b>
        </div>
        <span className={styles.entryReady}>
          <i aria-hidden="true" />
          私人空间已准备好
        </span>
        <h1 id="entry-title">把重要的人和片段，轻轻放在这里。</h1>
        <p>陪伴、复盘和日常对话，都可以有各自舒服的节奏。</p>
        <div className={styles.entryThemes} aria-label="三个产品空间">
          <span>陪伴</span>
          <span>复盘</span>
          <span>闲聊</span>
        </div>
      </section>

      <section className={styles.loginStage} aria-label="登录 Daily Brief">
        <div className={styles.loginCard}>
          <p className={styles.loginEyebrow}>Daily Brief</p>
          <h2>欢迎回来</h2>
          <p>使用演示身份进入这次界面探索。</p>
          <div className={styles.demoIdentity}>
            <span aria-hidden="true">DB</span>
            <div>
              <b>Daily Brief 体验账号</b>
              <small>仅用于浏览静态界面</small>
            </div>
            <em>演示</em>
          </div>
          <Link href={modulesPath} className={styles.loginAction}>
            使用演示账号登录 <Arrow />
          </Link>
          <small className={styles.loginBoundary}>
            不会验证、保存或发送任何账号信息
          </small>
        </div>
      </section>
    </main>
  );
}

export function CompanionModuleSelection() {
  return (
    <main
      className={styles.moduleRoot}
      data-entry-screen="module-selection"
      data-exploration-layout="desktop-first"
    >
      <header className={styles.moduleHeader}>
        <Link href={basePath} className={styles.moduleWordmark} aria-label="返回登录页">
          <span>DB</span>
          <b>Daily Brief</b>
        </Link>
        <Link href={basePath} className={styles.moduleExit}>退出演示</Link>
      </header>

      <section className={styles.moduleIntro}>
        <LocalTimeGreeting className={styles.localTimeGreeting} />
        <h1>今天，你想从哪里开始？</h1>
        <span>选择一个空间。每一种对话，都有自己的节奏。</span>
      </section>

      <section className={styles.moduleGrid} aria-label="三个产品空间">
        <Link
          href={prototypePath()}
          className={`${styles.moduleCard} ${styles.moduleCardDate}`}
          data-module="date-companion"
          data-theme="rose"
        >
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">相</span>
            <span className={styles.moduleAvailable}>现在可用</span>
          </div>
          <div className={styles.moduleCardCopy}>
            <p>FOR TWO</p>
            <h2>约会陪伴</h2>
            <span>记住一次相处，也在下次见面前想起重要的小事。</span>
          </div>
          <div className={styles.moduleCardMeta}>
            <span>上传一次相处 · 见面前看一眼</span>
            <b>进入约会陪伴 <Arrow /></b>
          </div>
        </Link>

        <article
          className={`${styles.moduleCard} ${styles.moduleCardOffice}`}
          data-module="office-recap"
          data-theme="mist-blue"
          aria-disabled="true"
        >
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">复</span>
          </div>
          <div className={styles.moduleCardCopy}>
            <p>FOR WORK</p>
            <h2>办公复盘</h2>
            <strong>开发中</strong>
            <span>把一段工作沟通，整理成清楚的决定与下一步。</span>
          </div>
          <div className={styles.moduleCardMeta}>
            <span>未来空间主题 · 雾蓝</span>
            <b>暂不可进入</b>
          </div>
        </article>

        <article
          className={`${styles.moduleCard} ${styles.moduleCardChat}`}
          data-module="daily-chat"
          data-theme="sage"
          aria-disabled="true"
        >
          <div className={styles.moduleCardTop}>
            <span className={styles.moduleGlyph} aria-hidden="true">聊</span>
          </div>
          <div className={styles.moduleCardCopy}>
            <p>FOR EVERYDAY</p>
            <h2>日常闲聊</h2>
            <strong>开发中</strong>
            <span>给没有明确任务的聊天，留一个轻松的地方。</span>
          </div>
          <div className={styles.moduleCardMeta}>
            <span>未来空间主题 · 鼠尾草绿</span>
            <b>暂不可进入</b>
          </div>
        </article>
      </section>

      <footer className={styles.moduleFooter}>
        这是一处隔离的静态界面探索，不会连接任何真实功能。
      </footer>
    </main>
  );
}

function ExplorationBar() {
  return (
    <div className={styles.explorationBar}>
      <Link href={modulesPath} className={styles.explorationBack}>
        <span aria-hidden="true">←</span>
        返回空间选择
      </Link>
      <span className={styles.explorationNote}>
        约会陪伴 · 静态界面演示 · 内容均为虚构
      </span>
    </div>
  );
}

function PrototypeNav({ screen }: { screen: PrototypeScreen }) {
  const labels: Record<PrototypeScreen, string> = {
    home: "此刻",
    person: "关于Ta",
    recap: "这次相处",
    prepare: "见面前"
  };

  return (
    <nav className={styles.prototypeNav} aria-label="约会陪伴页面">
      <div className={styles.prototypeNavLinks}>
        {prototypeScreens.map((item) => (
          <Link
            className={`${styles.prototypeNavLink} ${screen === item ? styles.prototypeNavLinkActive : ""}`}
            href={prototypePath(item)}
            key={item}
            aria-current={screen === item ? "page" : undefined}
          >
            {labels[item]}
          </Link>
        ))}
      </div>
      <StaticQuestionDrawer screen={screen} />
    </nav>
  );
}

function PrototypeFrame({
  screen,
  children
}: {
  screen: PrototypeScreen;
  children: ReactNode;
}) {
  return (
    <main
      className={`${styles.prototypeRoot} ${styles.prototypeRoot_a}`}
      data-exploration-layout="desktop-first"
      data-resolution-support="1080p-2k"
      data-theme="rose"
    >
      <ExplorationBar />
      <div className={styles.prototypeShell}>
        <PrototypeNav screen={screen} />
        {children}
      </div>
    </main>
  );
}

function AHome() {
  return (
    <div className={styles.aPage} data-relationship-mode="single-person">
      <section className={styles.aHero}>
        <LocalTimeGreeting className={`${styles.aDate} ${styles.localTimeGreeting}`} />
        <h1>今天，有什么值得留在心里？</h1>
        <p>把这次相处的完整录音交进来。整理成文字和片段后，再由你决定留下什么。</p>
        <details
          className={styles.aUploadAction}
          data-upload-mode="long-recording"
          data-panel-mode="dropdown-drawer"
        >
          <summary>
            <span className={styles.aUploadMark} aria-hidden="true">↑</span>
            <span className={styles.aUploadCopy}>
              <b>上传这次相处的录音</b>
              <small>把完整录音放进来，想留下什么由你决定</small>
            </span>
          </summary>
          <div
            className={styles.aUploadPanel}
            data-upload-drawer="anchored"
            role="region"
            aria-label="录音选择抽屉"
          >
            <div className={styles.aUploadDrop}>
              <span aria-hidden="true">＋</span>
              <b>把这次相处的声音放进来</b>
              <small>从电脑里选择一段完整录音 · 这里只演示入口</small>
            </div>
            <ol className={styles.aUploadSteps} aria-label="录音整理步骤">
              <li><b>上传完整录音</b><span>保留一整段相处</span></li>
              <li><b>转成文字并整理</b><span>提取值得确认的片段</span></li>
              <li><b>由你确认</b><span>确认后才进入Ta的记录</span></li>
            </ol>
            <Link href={prototypePath("recap")} className={styles.aUploadPreviewLink}>
              查看整理后的样例 <Arrow />
            </Link>
          </div>
        </details>
      </section>

      <section className={styles.aQuietSection}>
        <div className={styles.aSectionHeading}>
          <h2>你和林澄</h2>
          <span>认识Ta的第 86 天</span>
        </div>
        <Link href={prototypePath("person")} className={styles.aRelationshipCard}>
          <Avatar name="林澄" />
          <span className={styles.aRelationshipCopy}>
            <small>Ta最近</small>
            <b>第一次独立参加陶艺市集</b>
            <em>有点期待，也担心自己准备得不够好。</em>
          </span>
          <span className={styles.aRelationshipOpen}>打开关于Ta <Arrow /></span>
        </Link>
        <div className={styles.aRelationshipMeta}>
          <span>上次相处</span>
          <b>周日晚餐 · 河边散步</b>
        </div>
      </section>

      <section className={styles.aRemembered}>
        <p>上次相处，记住了什么</p>
        <blockquote>“Ta说，第一次独立参加市集，有点期待，也有点紧张。”</blockquote>
        <small>周日晚餐 · 林澄</small>
      </section>

      <Link href={prototypePath("prepare")} className={styles.aNextNote}>
        <span className={styles.aNoteDot} aria-hidden="true" />
        <span><small>下次见面前</small><b>周六傍晚 · 河边见林澄</b><em>Ta提到妈妈快过生日了</em></span>
        <span className={styles.aNextOpen}>打开准备卡 <Arrow /></span>
      </Link>
    </div>
  );
}

function APerson() {
  return (
    <div className={`${styles.aPage} ${styles.aPersonPage}`}>
      <header className={styles.aPersonHero}>
        <Avatar name="林澄" />
        <p>你们最近一次见面，是上周日的傍晚。</p>
        <h1>林澄</h1>
        <span>认识Ta的第 86 天</span>
      </header>

      <RelationshipSearch />
      <ExpandableProfileFacts />
      <RelationshipHistory />
      <section className={styles.aContinue}>
        <small>下次可以从这里继续</small>
        <p>“市集的摊位，最后决定带哪一组陶杯了吗？”</p>
        <Link href={prototypePath("prepare")}>
          <span className={styles.aActionCopy}>
            <b>见Ta前看一眼</b>
            <small>打开见面前提示，不会修改任何记录</small>
          </span>
          <Arrow />
        </Link>
      </section>
    </div>
  );
}

function ARecap() {
  return (
    <div className={`${styles.aPage} ${styles.aRecapPage}`}>
      <header className={styles.aRecapHero}>
        <span className={styles.aMoon} aria-hidden="true" />
        <p>周日晚餐 · 和林澄</p>
        <h1>这次相处，等你确认</h1>
        <span>完整录音已经转成文字，并整理成四个片段。</span>
        <div className={styles.aRecordingFile}>
          <small>本次录音</small>
          <b>周日晚餐.m4a</b>
          <span>1 小时 42 分钟 · 已整理</span>
        </div>
      </header>
      <section className={styles.aPromptList}>
        <div className={styles.aProcessingSteps} aria-label="本次录音整理进度">
          <span><b>01</b>录音已上传</span>
          <span><b>02</b>已经转成文字</span>
          <strong><b>03</b>等你确认</strong>
        </div>
        <StaticRecapReview />
      </section>
    </div>
  );
}

function PrepareSource({
  label,
  sourceLabel = "来自上次相处",
  meta,
  dateTime,
  speaker,
  quote
}: {
  label: string;
  sourceLabel?: string;
  meta: string;
  dateTime: string;
  speaker: "你" | "林澄";
  quote: string;
}) {
  return (
    <details className={styles.aPrepareSource} data-prepare-source>
      <summary aria-label={`回到原话：${label}`}>
        <span>{sourceLabel}</span>
        <b>回到原话</b>
      </summary>
      <blockquote>
        <time dateTime={dateTime}>{meta}</time>
        <p><b>{speaker}：</b>“{quote}”</p>
      </blockquote>
    </details>
  );
}

function APrepare() {
  return (
    <div className={`${styles.aPage} ${styles.aPreparePage}`}>
      <header>
        <p>周六 · 18:30 · 河边</p>
        <h1>见林澄之前，花半分钟想一想</h1>
        <span className={styles.aPagePurpose}>这是一张阅读卡，不会自动创建提醒或修改记录。</span>
      </header>
      <section className={styles.aLetterStack}>
        <details id="prepare-recent" open>
          <summary>Ta最近最在意的</summary>
          <div className={styles.aPrepareItem} data-prepare-item>
            <p>周末的陶艺市集能不能顺利。那是Ta第一次一个人摆摊。</p>
            <PrepareSource
              label="Ta最近最在意的"
              meta="8 月 2 日 · 周日晚餐 · 18:42"
              dateTime="2026-08-02T18:42:00+08:00"
              speaker="林澄"
              quote="第一次一个人摆摊，还是会担心准备得不够好。"
            />
          </div>
        </details>
        <details id="prepare-last-talk">
          <summary>你们上次聊到</summary>
          <div className={styles.aPrepareItem} data-prepare-item>
            <p>妈妈的生日快到了，Ta还没有决定送什么礼物。</p>
            <PrepareSource
              label="你们上次聊到"
              meta="8 月 2 日 · 周日晚餐 · 19:05"
              dateTime="2026-08-02T19:05:00+08:00"
              speaker="林澄"
              quote="妈妈生日快到了，我还没想好送花还是做一只杯子。"
            />
          </div>
        </details>
        <details id="prepare-promises">
          <summary>你答应过的事</summary>
          <ul className={styles.aPreparePromises} aria-label="见面前想起的约定">
            <li id="prepare-promise-record-store" data-prepare-item>
              <span className={styles.aPreparePromiseCopy}><small>还没做到</small><b>把唱片店的地址发给Ta</b></span>
              <PrepareSource
                label="把唱片店的地址发给Ta"
                meta="8 月 2 日 · 河边散步 · 20:16"
                dateTime="2026-08-02T20:16:00+08:00"
                speaker="你"
                quote="我回去把那家唱片店的地址发给你，那家周六下午也开门。"
              />
            </li>
            <li id="prepare-promise-birthday-flowers" data-prepare-item>
              <span className={styles.aPreparePromiseCopy}><small>还没做到</small><b>找一家适合给妈妈选花的店</b></span>
              <PrepareSource
                label="找一家适合给妈妈选花的店"
                meta="6 月 21 日 · 花店外 · 17:18"
                dateTime="2026-06-21T17:18:00+08:00"
                speaker="你"
                quote="我知道一家很安静的花店，回去把名字找给你。"
              />
            </li>
            <li id="prepare-promise-market-poster" data-prepare-item data-promise-state="done">
              <span className={styles.aPreparePromiseCopy}><small>已经做到</small><b>帮Ta看一遍市集介绍</b></span>
              <PrepareSource
                label="帮Ta看一遍市集介绍"
                meta="7 月 30 日 · 晚间通话 · 21:08"
                dateTime="2026-07-30T21:08:00+08:00"
                speaker="你"
                quote="你把市集介绍发我吧，我今晚帮你看一遍。"
              />
            </li>
          </ul>
          <p>不需要赶着全部完成，只是让你在见面前想起来。</p>
        </details>
        <details id="prepare-continue">
          <summary>可以自然继续的话题</summary>
          <div className={styles.aPrepareItem} data-prepare-item>
            <p>“市集的摊位，最后决定带哪一组陶杯了吗？”</p>
            <PrepareSource
              label="可以自然继续的话题"
              sourceLabel="根据上次话题整理"
              meta="8 月 2 日 · 周日晚餐 · 18:43"
              dateTime="2026-08-02T18:43:00+08:00"
              speaker="你"
              quote="最后决定带哪一组陶杯了吗？下次见面给我看看。"
            />
          </div>
        </details>
      </section>
      <blockquote>不需要准备很多。记得认真听Ta说话就好。</blockquote>
      <div className={styles.aPrepareActions}>
        <Link href={prototypePath("recap")} className={styles.aReviewLink}>查看最近一次相处</Link>
        <Link href={prototypePath("person")} className={styles.aReadyLink}>
          <span className={styles.aReadyCopy}>
            <b>看完了，回到林澄</b>
            <small>只结束这次查看，不会修改任何内容</small>
          </span>
          <Arrow />
        </Link>
      </div>
    </div>
  );
}

const screens: Record<PrototypeScreen, () => ReactNode> = {
  home: AHome,
  person: APerson,
  recap: ARecap,
  prepare: APrepare
};

export function CompanionPrototype({ screen }: { screen: PrototypeScreen }) {
  const Screen = screens[screen];
  return (
    <PrototypeFrame screen={screen}>
      <Screen />
    </PrototypeFrame>
  );
}
