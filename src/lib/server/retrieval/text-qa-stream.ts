import { randomUUID } from "node:crypto";

import {
  encodeQaBrowserStreamEvent,
  type QaBrowserStreamEvent
} from "@/lib/qa-browser-stream";
import {
  answerQuestionStream,
  type AnswerQuestionStreamInput
} from "@/lib/server/retrieval/ai-qa";
import type { QaAnswerStreamEvent } from "@/lib/server/retrieval/qa-streaming";

type FinalQaStreamEvent = Extract<QaAnswerStreamEvent, { type: "final" }>;

export type TextQaStreamFinalizer = (event: FinalQaStreamEvent) => void | Promise<void>;

export type TextQaBrowserStreamOptions = {
  input: AnswerQuestionStreamInput;
  onFinal?: TextQaStreamFinalizer;
  dependencies?: {
    answerQuestionStream?: typeof answerQuestionStream;
  };
};

export function acceptsQaBrowserStream(request: Request) {
  const accept = request.headers.get("accept");
  if (!accept) return false;

  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry
      .split(";")
      .map((part) => part.trim().toLowerCase());
    if (mediaType !== "application/x-ndjson") return false;
    return !parameters.some((parameter) => /^q=0(?:\.0*)?$/u.test(parameter));
  });
}

function safeEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: QaBrowserStreamEvent
) {
  controller.enqueue(encodeQaBrowserStreamEvent(event));
}

/**
 * Browser-safe projection of the QA provider stream.
 *
 * Raw provider token deltas intentionally never cross this boundary. The only
 * incremental content exposed to the browser has already passed the shared
 * sentence-level grounding validation.
 */
export function createTextQaBrowserStream(options: TextQaBrowserStreamOptions) {
  const streamFactory =
    options.dependencies?.answerQuestionStream ?? answerQuestionStream;
  let iterator: AsyncIterator<QaAnswerStreamEvent> | null = null;
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let completed = false;
        let metadataSent = false;
        let browserSentenceSequence = 0;
        const ensureMetadata = (streamId: string = randomUUID()) => {
          if (metadataSent) return;
          safeEnqueue(controller, { type: "meta", version: 1, streamId });
          metadataSent = true;
        };
        try {
          iterator = streamFactory(options.input)[Symbol.asyncIterator]();
          while (!cancelled) {
            const next = await iterator.next();
            if (next.done) break;
            const event = next.value;

            if (event.type === "stream_started") {
              ensureMetadata(event.streamId);
              continue;
            }

            if (event.type === "sentence_completed") {
              if (
                event.groundingValidated !== true ||
                event.validated !== true ||
                event.status !== "committed"
              ) {
                continue;
              }
              ensureMetadata();
              browserSentenceSequence += 1;
              safeEnqueue(controller, {
                type: "sentence",
                sequence: browserSentenceSequence,
                text: event.text,
                supportIds: event.supportIds,
                citedSegmentIds: event.citedSegmentIds,
                groundingValidated: true
              });
              continue;
            }

            if (event.type === "final") {
              ensureMetadata();
              await options.onFinal?.(event);
              safeEnqueue(controller, {
                type: "final",
                answer: event.answer,
                source: event.source
              });
              safeEnqueue(controller, {
                type: "complete",
                status:
                  event.trace.status === "completed"
                    ? "completed"
                    : "completed_with_fallback"
              });
              completed = true;
              break;
            }
          }

          if (!cancelled && !completed) {
            ensureMetadata();
            safeEnqueue(controller, {
              type: "error",
              code: "qa_stream_incomplete",
              recoverable: true
            });
            safeEnqueue(controller, { type: "complete", status: "failed" });
          }
        } catch {
          if (!cancelled) {
            ensureMetadata();
            safeEnqueue(controller, {
              type: "error",
              code: "qa_stream_failed",
              recoverable: true
            });
            safeEnqueue(controller, { type: "complete", status: "failed" });
          }
        } finally {
          if (!cancelled) controller.close();
        }
      })();
    },
    async cancel() {
      cancelled = true;
      await iterator?.return?.();
    }
  });
}

export function textQaNdjsonResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
