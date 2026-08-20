class DailyBriefVoicePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.phase = 0;
    this.samples = new Int16Array(320);
    this.sampleIndex = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      this.phase += this.targetRate;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const sample = Math.max(-1, Math.min(1, channel[index] || 0));
      this.samples[this.sampleIndex] = sample < 0
        ? Math.round(sample * 0x8000)
        : Math.round(sample * 0x7fff);
      this.sampleIndex += 1;
      if (this.sampleIndex === this.samples.length) {
        const packet = this.samples.buffer;
        this.port.postMessage(packet, [packet]);
        this.samples = new Int16Array(320);
        this.sampleIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor(
  "daily-brief-voice-pcm-processor",
  DailyBriefVoicePcmProcessor
);
