"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PrototypeScreen } from "./companion-prototypes";
import styles from "./exploration.module.css";

type QuestionSource = {
  occasion: string;
  time: string;
  dateTime: string;
  speaker: string;
  quote: string;
};

type QuestionSample = {
  question: string;
  answer: string;
  sources: QuestionSource[];
};

type QuestionContext = {
  section: string;
  title: string;
  intro: string;
  questions: QuestionSample[];
};

const questionFragments = {
  marketConcern: {
    occasion: "周日晚餐", time: "18:42", dateTime: "2026-08-02T18:42:00+08:00", speaker: "林澄", quote: "第一次一个人摆摊，还是会担心准备得不够好。"
  },
  marketCups: {
    occasion: "周日晚餐", time: "18:37", dateTime: "2026-08-02T18:37:00+08:00", speaker: "林澄", quote: "我还在挑要带去市集的那一组杯子，想再看一晚。"
  },
  promiseAddress: {
    occasion: "河边散步", time: "20:16", dateTime: "2026-08-02T20:16:00+08:00", speaker: "你", quote: "我回去把那家唱片店的地址发给你。"
  },
  recordStore: {
    occasion: "唱片店", time: "15:26", dateTime: "2026-07-05T15:26:00+08:00", speaker: "林澄", quote: "这家店周六下午也开门，下次可以再来。"
  },
  birthday: {
    occasion: "花店外", time: "17:12", dateTime: "2026-06-21T17:12:00+08:00", speaker: "林澄", quote: "妈妈快过生日了，我还没想好要送什么。"
  },
  scarf: {
    occasion: "河边散步", time: "19:27", dateTime: "2026-08-02T19:27:00+08:00", speaker: "林澄", quote: "风这么大，围巾给你一半吧。"
  },
  bookstore: {
    occasion: "旧书店门口", time: "16:08", dateTime: "2026-07-19T16:08:00+08:00", speaker: "林澄", quote: "我喜欢书页边上有以前读者留下的小字。"
  },
  coffee: {
    occasion: "巷口咖啡", time: "16:02", dateTime: "2026-07-05T16:02:00+08:00", speaker: "林澄", quote: "桂花味很像秋天刚开始的那几天。"
  },
  continueTopic: {
    occasion: "周日晚餐", time: "18:43", dateTime: "2026-08-02T18:43:00+08:00", speaker: "你", quote: "最后决定带哪一组陶杯了吗？下次见面给我看看。"
  },
  listening: {
    occasion: "周日晚餐", time: "18:45", dateTime: "2026-08-02T18:45:00+08:00", speaker: "你", quote: "你慢慢说，我想听听你最担心的是哪一部分。"
  }
} satisfies Record<string, QuestionSource>;

const questionContexts: Record<PrototypeScreen, QuestionContext> = {
  home: {
    section: "此刻",
    title: "关于林澄，想问什么？",
    intro: "可以从已经留下的相处片段里，快速想起一件重要的小事。",
    questions: [
      {
        question: "Ta最近提到过什么？",
        answer: "Ta最近反复提到周末的陶艺市集。那是Ta第一次独立摆摊，Ta很期待，也担心自己准备得还不够好。",
        sources: [questionFragments.marketConcern, questionFragments.marketCups]
      },
      {
        question: "我答应过Ta什么？",
        answer: "你答应把那家唱片店的地址发给Ta。现在这件事还没有被标记为已经做到。",
        sources: [questionFragments.promiseAddress, questionFragments.recordStore]
      },
      {
        question: "下次见面可以从哪里聊起？",
        answer: "可以自然地问问Ta，市集最后决定带哪一组陶杯，也可以关心一下妈妈的生日准备。",
        sources: [questionFragments.continueTopic, questionFragments.birthday]
      }
    ]
  },
  person: {
    section: "关于Ta",
    title: "想更好地想起林澄？",
    intro: "不用翻找所有片段，从关于Ta的问题开始就好。",
    questions: [
      {
        question: "林澄喜欢什么？",
        answer: "Ta喜欢旧书店、桂花拿铁和傍晚散步，也喜欢保留手作陶器里不那么完美的质感。",
        sources: [questionFragments.bookstore, questionFragments.coffee]
      },
      {
        question: "Ta最近在准备什么？",
        answer: "Ta在准备第一次独立参加的陶艺市集，最近一直在挑选要带去的作品。",
        sources: [questionFragments.marketCups, questionFragments.marketConcern]
      },
      {
        question: "我们上次聊到了哪里？",
        answer: "上次你们聊到市集摊位和Ta妈妈快到的生日。你还答应把唱片店地址发给Ta。",
        sources: [questionFragments.marketConcern, questionFragments.promiseAddress]
      }
    ]
  },
  recap: {
    section: "这次相处",
    title: "想换个角度看看这次相处？",
    intro: "这次整理还在等你确认。这里的回答只是静态查看样例，不会替你留下内容。",
    questions: [
      {
        question: "帮我回顾这次值得记住的内容。",
        answer: "这次最温柔的片段，是河边风很大时，Ta把围巾分了一半给你。Ta也认真说起了第一次独立摆摊的不安。",
        sources: [questionFragments.scarf, questionFragments.marketConcern]
      },
      {
        question: "Ta这次最在意什么？",
        answer: "Ta最在意陶艺市集能不能顺利，也担心自己的作品还不够成熟。",
        sources: [questionFragments.marketConcern, questionFragments.marketCups]
      },
      {
        question: "这次我答应了什么？",
        answer: "你说回去以后会把那家唱片店的地址发给Ta。",
        sources: [questionFragments.promiseAddress, questionFragments.recordStore]
      }
    ]
  },
  prepare: {
    section: "见面前",
    title: "见Ta之前，想快速想起什么？",
    intro: "不需要准备很多，带着一两件真正在意的小事出发就够了。",
    questions: [
      {
        question: "见Ta之前，我最需要想起什么？",
        answer: "记得Ta正在为第一次独立参加陶艺市集而紧张。见面时先认真听听Ta最近准备得怎么样。",
        sources: [questionFragments.marketConcern, questionFragments.listening]
      },
      {
        question: "有没有还没做到的约定？",
        answer: "还有一个唱片店地址没有发给Ta。见面前补上，会比准备很多话题更自然。",
        sources: [questionFragments.promiseAddress, questionFragments.recordStore]
      },
      {
        question: "可以自然地怎么开场？",
        answer: "可以问Ta：‘市集的摊位，最后决定带哪一组陶杯了吗？’",
        sources: [questionFragments.continueTopic, questionFragments.marketCups]
      }
    ]
  }
};

const fallbackAnswers: Record<PrototypeScreen, string> = {
  home: "这个静态样例会先帮你想起：林澄最近最在意第一次独立参加的陶艺市集，也还有一个唱片店地址等你发给Ta。",
  person: "这个静态样例会从你和林澄已经留下的片段里，挑出与问题最接近的小事，方便你继续回看。",
  recap: "这个静态样例会先回到这次周日晚餐：Ta说起了市集的不安，你也答应把唱片店地址发给Ta。",
  prepare: "这个静态样例会把见面前最值得想起的事放在一起：Ta的市集、妈妈的生日，以及你还没发出的唱片店地址。"
};

const fallbackSources: Record<PrototypeScreen, QuestionSource[]> = {
  home: [questionFragments.marketConcern, questionFragments.promiseAddress],
  person: [questionFragments.marketConcern, questionFragments.bookstore],
  recap: [questionFragments.marketConcern, questionFragments.promiseAddress],
  prepare: [questionFragments.marketConcern, questionFragments.promiseAddress]
};

export function StaticQuestionDrawer({ screen }: { screen: PrototypeScreen }) {
  const context = questionContexts[screen];
  const [isOpen, setIsOpen] = useState(false);
  const [selectedQuestion, setSelectedQuestion] = useState<number | null>(null);
  const [showAnswer, setShowAnswer] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeQuestion, setActiveQuestion] = useState("");
  const [activeAnswer, setActiveAnswer] = useState("");
  const [activeSources, setActiveSources] = useState<QuestionSource[]>([]);
  const [questionHistory, setQuestionHistory] = useState<string[]>([]);
  const [isMounted, setIsMounted] = useState(false);
  const titleId = useId();
  const drawerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    closeRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        setSelectedQuestion(null);
        setShowAnswer(false);
        setDraft("");
        setActiveQuestion("");
        setActiveAnswer("");
        setActiveSources([]);
        triggerRef.current?.focus();
      }
      if (event.key === "Tab") {
        const drawer = document.getElementById(drawerId);
        if (!drawer) return;
        const focusable = Array.from(
          drawer.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'
          )
        ).filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [drawerId, isOpen]);

  const closeDrawer = () => {
    setIsOpen(false);
    setSelectedQuestion(null);
    setShowAnswer(false);
    setDraft("");
    setActiveQuestion("");
    setActiveAnswer("");
    setActiveSources([]);
    triggerRef.current?.focus();
  };

  const chooseQuestion = (index: number) => {
    setSelectedQuestion(index);
    setDraft(context.questions[index].question);
    setShowAnswer(false);
    setActiveQuestion("");
    setActiveAnswer("");
    setActiveSources([]);
  };

  const showStaticAnswer = (question = draft) => {
    const nextQuestion = question.trim();
    if (!nextQuestion) return;
    const matchingIndex = context.questions.findIndex((item) => item.question === nextQuestion);
    setSelectedQuestion(matchingIndex === -1 ? null : matchingIndex);
    setDraft(nextQuestion);
    setActiveQuestion(nextQuestion);
    setActiveAnswer(
      matchingIndex === -1 ? fallbackAnswers[screen] : context.questions[matchingIndex].answer
    );
    setActiveSources(
      matchingIndex === -1 ? fallbackSources[screen] : context.questions[matchingIndex].sources
    );
    setQuestionHistory((current) => [
      nextQuestion,
      ...current.filter((item) => item !== nextQuestion)
    ].slice(0, 4));
    setShowAnswer(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.questionTrigger}
        data-emphasis="primary"
        aria-label="问问 Daily Brief"
        aria-haspopup="dialog"
        aria-controls={drawerId}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(true)}
      >
        <span className={styles.questionTriggerMark} aria-hidden="true">✦</span>
        <span className={styles.questionTriggerLabel}>问问 Daily Brief</span>
        <span className={styles.questionTriggerArrow} aria-hidden="true">↗</span>
      </button>

      {isMounted && isOpen
        ? createPortal(
            <div className={styles.questionLayer} data-question-screen={screen}>
              <button
                type="button"
                className={styles.questionBackdrop}
                aria-label="关闭问问 Daily Brief"
                onClick={closeDrawer}
              />
              <aside
                id={drawerId}
                className={styles.questionDrawer}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
              >
                <header className={styles.questionHeader}>
                  <div>
                    <p>{context.section}</p>
                    <h2 id={titleId}>问问 Daily Brief</h2>
                  </div>
                  <button
                    ref={closeRef}
                    type="button"
                    className={styles.questionClose}
                    aria-label="关闭问问 Daily Brief"
                    onClick={closeDrawer}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </header>

                <div className={styles.questionBody}>
                  <section className={styles.questionWelcome}>
                    <span aria-hidden="true">DB</span>
                    <div>
                      <h3>{context.title}</h3>
                      <p>{context.intro}</p>
                    </div>
                  </section>

                  <div className={styles.questionSuggestions} aria-label="问题样例">
                    {context.questions.map((item, index) => (
                      <button
                        type="button"
                        key={item.question}
                        className={selectedQuestion === index ? styles.questionSuggestionSelected : ""}
                        aria-pressed={selectedQuestion === index}
                        onClick={() => chooseQuestion(index)}
                      >
                        {item.question}
                        <span aria-hidden="true">→</span>
                      </button>
                    ))}
                  </div>

                  <section className={styles.questionHistory} data-module="question-history" aria-label="刚刚问过">
                    <header><b>刚刚问过</b><small>只保留在当前 UI Demo</small></header>
                    {questionHistory.length ? (
                      <div>
                        {questionHistory.map((question) => (
                          <button
                            type="button"
                            key={question}
                            aria-label={`重新查看：${question}`}
                            onClick={() => showStaticAnswer(question)}
                          >
                            {question}
                          </button>
                        ))}
                      </div>
                    ) : <p>还没有问过。可以从上面的样例开始，也可以自己写一句。</p>}
                  </section>

                  {showAnswer ? (
                    <article className={styles.questionAnswer} aria-live="polite">
                      <small>静态回答样例</small>
                      <h3>“{activeQuestion}”</h3>
                      <p>{activeAnswer}</p>
                      <details className={styles.questionSources}>
                        <summary>回到原话 · {activeSources.length} 段相处</summary>
                        <div>
                          {activeSources.map((source) => (
                            <blockquote key={source.dateTime}>
                              <span><b>{source.occasion}</b><time dateTime={source.dateTime}>{source.time}</time></span>
                              <p>{source.speaker}：“{source.quote}”</p>
                            </blockquote>
                          ))}
                        </div>
                      </details>
                    </article>
                  ) : (
                    <div className={styles.questionEmpty}>
                      选择一个问题，或自己写一句，再看看静态回答会怎样出现。
                    </div>
                  )}
                </div>

                <footer className={styles.questionComposer} aria-label="静态提问栏">
                  <label htmlFor={`${drawerId}-question`}>想问的内容</label>
                  <form onSubmit={(event) => { event.preventDefault(); showStaticAnswer(); }}>
                    <input
                      id={`${drawerId}-question`}
                      value={draft}
                      placeholder="例如：Ta最近最在意什么？"
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setSelectedQuestion(null);
                        setShowAnswer(false);
                      }}
                    />
                    <button
                      type="submit"
                      aria-label="显示静态回答样例"
                      disabled={!draft.trim()}
                    >
                      看看回答
                    </button>
                  </form>
                  <small>这里只演示输入、问过记录与回答依据，不会发送或保存问题。</small>
                </footer>
              </aside>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
