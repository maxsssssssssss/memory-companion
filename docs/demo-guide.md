# Demo Guide

This guide is for a stable local mentor demo of the dating / relationship review flow.

## Demo Goal

Show that the project can turn uploaded or preprocessed recordings into:

- daily brief items;
- semantic timeline and transcript evidence;
- audio / tone insights;
- Relationship Signal Cards;
- proactive QA suggestions;
- current / week / all memory scope UX.

The demo should frame the product as an evidence-based relationship review tool, not as a personality judge, diagnosis tool, or breakup recommender.

## Local Demo Account

Use the local demo account prepared for this workspace. Keep the password outside source files.

This account contains ready demo data for 2026-07-09:

- technical / non-relationship recordings with no relationship signal cards;
- relationship conversation recordings with relationship signal cards;
- aggregated daily brief data across multiple recordings.

## Run Locally

```powershell
npm run dev -- -p 3200
```

Open:

```text
http://localhost:3200
```

## Suggested Demo Flow

1. Log in with the local demo account.
2. Open the 2026-07-09 recording day.
3. Start from `每日复盘`.
4. Point out the aggregated daily brief totals and evidence-backed items.
5. Show the `关系信号` section:
   - positive cards are grouped under `积极信号`;
   - cards show signal type, confidence, severity, speaker, time range, and evidence;
   - copy stays cautious and does not make personality judgments.
6. Switch to `时间轴` to show semantic segments and transcript evidence.
7. Switch to `问答`.
8. Show `你可能想问` proactive QA suggestions.
9. Ask a current-recording question such as:

```text
这次录音里有哪些明确承诺需要回看？
```

10. Show the `当前录音` / `本周范围` / `全部记忆` scope UI:
    - current scope is limited to the selected recording/day;
    - week scope is framed as this week's processed recordings;
    - all scope includes a caution that long-term conclusions need enough evidence.

## Demo Data Choices

Best existing fixtures:

- `fixtures/audio/non_relationship_60s.wav`: technical discussion; expected relationship signals: empty.
- `fixtures/audio/relationship_dialogue_90s.wav`: simulated relationship conversation; expected relationship signals: present.
- `fixtures/audio/two_speaker_relationship.wav`: synthetic two-role conversation for diarization smoke testing.

The current prepared local account already contains processed examples, so the fastest demo should use existing ready data instead of rerunning ASR.

## Expected Results

For the prepared relationship recording:

- upload status: `ready`;
- transcript segments: present;
- audio insights: present;
- semantic segments: present;
- brief items: present;
- relationship signals: present;
- proactive QA suggestions: present;
- QA answer should avoid fixed refusal when the question maps to existing evidence.

For the prepared non-relationship recording:

- relationship signals should be `[]`;
- the UI should show an empty relationship signal state instead of forcing cards.

## Safety Boundaries

During demo, avoid claiming the system can identify a bad partner or diagnose someone.

Do not say:

- `渣男` / `渣女`;
- personality diagnosis;
- psychological diagnosis;
- definite manipulation judgment;
- direct breakup recommendation.

Preferred framing:

- evidence review;
- interaction signals;
- uncertainty;
- suggested reflection;
- questions worth clarifying.

## Known Limits

- The current local demo account mainly has one processed date, so week / all scopes show the UX and conservative framing but not a rich multi-day memory trend.
- Relationship Signal Cards are displayed and used for proactive suggestions, but they are not yet a retrieval evidence source for QA.
- `all memory` is still aggregate retrieval, not a memory index or vector database.
- Speaker identity is not tracked across days.
- For a live ASR run with `speaker-asr`, the audio URL must be publicly reachable by the remote ASR service.

## Recommended Next Demo Hardening

- Add at least two more processed relationship recordings on different dates.
- Keep one non-relationship recording in the account to prove empty relationship-signal behavior.
- Add one clearly two-speaker ready sample if diarization needs to be demonstrated visually.
- Keep QA questions close to visible brief categories: commitment, task, open question, decision, tone, and relationship evidence.
