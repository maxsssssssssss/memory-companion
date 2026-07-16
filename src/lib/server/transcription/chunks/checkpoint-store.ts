import {
  AudioChunkSchema,
  TranscriptChunkSchema,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { JsonStore } from "@/lib/server/storage/json-store";

const AUDIO_CHUNKS_COLLECTION = "audio-chunks";
const TRANSCRIPT_CHUNKS_COLLECTION = "transcript-chunks";

export interface ChunkCheckpointStore {
  saveAudioChunk(chunk: AudioChunk): Promise<void>;
  saveTranscriptChunk(chunk: TranscriptChunk): Promise<void>;
  listAudioChunks(uploadId: string): Promise<AudioChunk[]>;
  listTranscriptChunks(uploadId: string): Promise<TranscriptChunk[]>;
  deleteUpload(uploadId: string): Promise<void>;
}

export class JsonChunkCheckpointStore implements ChunkCheckpointStore {
  constructor(private readonly store: JsonStore) {}

  async saveAudioChunk(chunk: AudioChunk) {
    const parsed = AudioChunkSchema.parse(chunk);
    await this.store.write(AUDIO_CHUNKS_COLLECTION, parsed.id, parsed);
  }

  async saveTranscriptChunk(chunk: TranscriptChunk) {
    const parsed = TranscriptChunkSchema.parse(chunk);
    await this.store.write(TRANSCRIPT_CHUNKS_COLLECTION, parsed.id, parsed);
  }

  async readAudioChunk(chunkId: string) {
    const value = await this.store.read<unknown>(AUDIO_CHUNKS_COLLECTION, chunkId);
    if (!value) {
      return null;
    }
    return AudioChunkSchema.parse(value);
  }

  async listAudioChunks(uploadId: string) {
    const records = (await this.store.list<unknown>(AUDIO_CHUNKS_COLLECTION)) ?? [];
    return records
      .flatMap((record) => {
        const parsed = AudioChunkSchema.safeParse(record.value);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((chunk) => chunk.uploadId === uploadId)
      .sort((left, right) => left.index - right.index);
  }

  async listTranscriptChunks(uploadId: string) {
    const records = (await this.store.list<unknown>(TRANSCRIPT_CHUNKS_COLLECTION)) ?? [];
    return records
      .flatMap((record) => {
        const parsed = TranscriptChunkSchema.safeParse(record.value);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((chunk) => chunk.uploadId === uploadId)
      .sort((left, right) => left.index - right.index);
  }

  async deleteUpload(uploadId: string) {
    const [audioChunks, transcriptChunks] = await Promise.all([
      this.listAudioChunks(uploadId),
      this.listTranscriptChunks(uploadId)
    ]);
    await Promise.all([
      ...audioChunks.map((chunk) => this.store.delete(AUDIO_CHUNKS_COLLECTION, chunk.id)),
      ...transcriptChunks.map((chunk) => this.store.delete(TRANSCRIPT_CHUNKS_COLLECTION, chunk.id))
    ]);
  }
}

export async function readAudioChunkCheckpoint(store: JsonStore, chunkId: string) {
  return await new JsonChunkCheckpointStore(store).readAudioChunk(chunkId);
}
