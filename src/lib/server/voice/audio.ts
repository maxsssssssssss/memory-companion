export type Pcm16LeAudioFormat = {
  sampleRate: number;
  channels: number;
};

export const DEFAULT_VOICE_OUTPUT_AUDIO_FORMAT = {
  encoding: "pcm_s16le",
  sampleRate: 24_000,
  channels: 1
} as const;

const PCM_BITS_PER_SAMPLE = 16;
const PCM_BYTES_PER_SAMPLE = PCM_BITS_PER_SAMPLE / 8;
const WAV_HEADER_SIZE = 44;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffff_ffff;

function validatePcm16LeInput(pcm: Buffer, format: Pcm16LeAudioFormat) {
  if (!Buffer.isBuffer(pcm)) {
    throw new TypeError("PCM audio must be provided as a Buffer.");
  }

  if (pcm.byteLength === 0) {
    throw new RangeError("PCM audio must not be empty.");
  }

  if (!Number.isSafeInteger(format.sampleRate) || format.sampleRate <= 0 || format.sampleRate > MAX_UINT32) {
    throw new RangeError("PCM sampleRate must be a positive integer representable in a WAV header.");
  }

  if (!Number.isSafeInteger(format.channels) || format.channels <= 0 || format.channels > MAX_UINT16) {
    throw new RangeError("PCM channels must be a positive integer representable in a WAV header.");
  }

  const blockAlign = format.channels * PCM_BYTES_PER_SAMPLE;
  if (blockAlign > MAX_UINT16) {
    throw new RangeError("PCM frame size is too large for a WAV header.");
  }

  if (pcm.byteLength % blockAlign !== 0) {
    throw new RangeError(`PCM byte length must be aligned to complete ${blockAlign}-byte sample frames.`);
  }

  const byteRate = format.sampleRate * blockAlign;
  if (!Number.isSafeInteger(byteRate) || byteRate > MAX_UINT32) {
    throw new RangeError("PCM byte rate is too large for a WAV header.");
  }

  if (pcm.byteLength > MAX_UINT32 - 36) {
    throw new RangeError("PCM audio is too large for a standard WAV file.");
  }

  return { blockAlign, byteRate };
}

export function wrapPcm16LeAsWav(pcm: Buffer, format: Pcm16LeAudioFormat) {
  const { blockAlign, byteRate } = validatePcm16LeInput(pcm, format);
  const wav = Buffer.allocUnsafe(WAV_HEADER_SIZE + pcm.byteLength);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(format.channels, 22);
  wav.writeUInt32LE(format.sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(wav, WAV_HEADER_SIZE);

  return wav;
}

export function getPcm16DurationMs(pcm: Buffer, format: Pcm16LeAudioFormat) {
  const { byteRate } = validatePcm16LeInput(pcm, format);
  return (pcm.byteLength / byteRate) * 1_000;
}
