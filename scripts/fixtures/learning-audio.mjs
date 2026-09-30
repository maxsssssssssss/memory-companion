// Synthetic 440 Hz tone, not speech or user material. Valid PCM WAV for local I/O tests.
export function syntheticLearningWav(seconds = 1) {
  const count = Math.round(16000 * seconds); const result = Buffer.alloc(44 + count * 2);
  result.write("RIFF", 0); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16000, 24); result.writeUInt32LE(32000, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write("data", 36); result.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) result.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + i * 2);
  return result;
}
