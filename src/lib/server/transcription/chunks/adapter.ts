import type { AudioChunk, TranscriptChunk } from "@/lib/domain/chunks";
import type { AudioAccessPolicy } from "../provider";

export type ChunkTranscriptionAdapterInput = {
  chunk: AudioChunk;
  userId?: string;
  audioAccessPolicy?: AudioAccessPolicy;
  signal: AbortSignal;
};

export type ChunkTranscriptionAdapter = {
  readonly name: string;
  transcribeChunk(input: ChunkTranscriptionAdapterInput): Promise<TranscriptChunk>;
};

export class ChunkTranscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ChunkTranscriptionError";
  }
}
