"use client";

import { formatTime } from "@/lib/domain/time";
import { speakerDisplayNameForUpload, type SpeakerAliasLookup } from "@/lib/domain/speaker-aliases";
import type { RelationshipSignalCard, RelationshipSignalCategory, RelationshipSignalSeverity, RelationshipSignalType } from "@/lib/domain/types";

type RelationshipSignalCardsProps = {
  cards: RelationshipSignalCard[];
  speakerAliasesByUploadId?: SpeakerAliasLookup;
};

const categoryLabels: Record<RelationshipSignalCategory, string> = {
  positive: "积极信号",
  uncertain: "需要澄清",
  risk: "需要留意"
};

const signalTypeLabels: Record<RelationshipSignalType, string> = {
  active_listening: "主动倾听",
  emotional_support: "情绪接住",
  boundary_respect: "尊重边界",
  clear_commitment: "承诺明确",
  evasive_answer: "回避回答",
  invalidating_or_belittling: "贬低 / 否定"
};

const severityLabels: Record<RelationshipSignalSeverity, string> = {
  low: "轻",
  medium: "中",
  high: "高"
};

const categoryOrder: RelationshipSignalCategory[] = ["positive", "uncertain", "risk"];

function speakerList(card: RelationshipSignalCard, aliases: SpeakerAliasLookup) {
  return card.involvedSpeakers
    .map((speakerId) => speakerDisplayNameForUpload(card.uploadId, speakerId, aliases) ?? speakerId)
    .join(", ");
}

function cardGroups(cards: RelationshipSignalCard[]) {
  return categoryOrder.map((category) => ({
    category,
    cards: cards.filter((card) => card.signalCategory === category)
  }));
}

export function RelationshipSignalCards({ cards, speakerAliasesByUploadId = {} }: RelationshipSignalCardsProps) {
  return (
    <section className="sec anim relationship-signal-section" aria-labelledby="relationship-signals-title">
      <div className="sec-head">
        <div className="ic ic-sage" aria-hidden="true">
          i
        </div>
        <h2 id="relationship-signals-title">关系信号</h2>
        <span className="ct">{cards.length} 张</span>
      </div>

      {cards.length === 0 ? (
        <p className="panel-empty section-empty">这段录音里暂未提取到足够明确的关系信号。</p>
      ) : (
        <div className="relationship-signal-groups">
          {cardGroups(cards).map(({ category, cards: groupCards }) =>
            groupCards.length > 0 ? (
              <section key={category} className={`relationship-signal-group relationship-signal-group-${category}`}>
                <h3>{categoryLabels[category]}</h3>
                <div className="relationship-signal-list">
                  {groupCards.map((card) => (
                    <article key={card.id} className={`relationship-signal-card relationship-signal-card-${card.signalCategory}`}>
                      <div className="relationship-signal-card-head">
                        <div>
                          <span className="relationship-signal-type">{signalTypeLabels[card.signalType]}</span>
                          <h4>{card.summary}</h4>
                        </div>
                        <div className="relationship-signal-score">
                          <b>{Math.round(card.confidence * 100)}%</b>
                          <span>{severityLabels[card.severity]}</span>
                        </div>
                      </div>

                      <div className="relationship-signal-meta">
                        <span>{speakerList(card, speakerAliasesByUploadId)}</span>
                        <span>
                          {formatTime(card.timeRange.startSeconds)}-{formatTime(card.timeRange.endSeconds)}
                        </span>
                      </div>

                      <details className="relationship-signal-details">
                        <summary>查看证据和追问</summary>
                        <p>{card.explanation}</p>
                        {card.caution ? <p className="relationship-signal-caution">{card.caution}</p> : null}
                        <div className="relationship-signal-evidence">
                          {card.evidenceSegments.map((segment) => (
                            <blockquote key={segment.segmentId}>
                              <span>
                                {formatTime(segment.startSeconds)}-{formatTime(segment.endSeconds)}
                                {segment.speaker ? ` · ${speakerDisplayNameForUpload(card.uploadId, segment.speaker, speakerAliasesByUploadId) ?? segment.speaker}` : ""}
                              </span>
                              <p>{segment.text}</p>
                            </blockquote>
                          ))}
                        </div>
                        <p className="relationship-signal-reflection">{card.suggestedReflection}</p>
                      </details>
                    </article>
                  ))}
                </div>
              </section>
            ) : null
          )}
        </div>
      )}
    </section>
  );
}
