// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

type ProcessorConstructor = new () => {
  port: {
    onmessage?: (event: { data: unknown }) => void;
  };
  process(inputs: Float32Array[][]): boolean;
};

function loadProcessor(inputSampleRate: number) {
  let Processor: ProcessorConstructor | undefined;
  const packets: ArrayBuffer[] = [];
  class AudioWorkletProcessorStub {
    readonly port = {
      onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
      postMessage: (packet: ArrayBuffer) => packets.push(packet)
    };
  }
  const source = readFileSync(
    `${process.cwd()}/public/voice-pcm-worklet.js`,
    "utf8"
  );
  runInNewContext(source, {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Int16Array,
    Math,
    sampleRate: inputSampleRate,
    registerProcessor: (name: string, value: ProcessorConstructor) => {
      expect(name).toBe("daily-brief-voice-pcm-processor");
      Processor = value;
    }
  });
  if (!Processor) throw new Error("PCM AudioWorklet did not register");
  return { processor: new Processor(), packets };
}

describe("Realtime Voice PCM AudioWorklet", () => {
  it.each([
    { sampleRate: 48_000, inputSamples: 960 },
    { sampleRate: 44_100, inputSamples: 882 }
  ])("frames 20 ms of $sampleRate Hz input as 320 PCM16 samples", ({
    sampleRate,
    inputSamples
  }) => {
    const { processor, packets } = loadProcessor(sampleRate);
    const input = new Float32Array(inputSamples).fill(0.5);

    expect(processor.process([[input]])).toBe(true);
    expect(packets).toHaveLength(1);
    expect(packets[0]?.byteLength).toBe(640);
    expect(new Int16Array(packets[0]!)[0]).toBe(16_384);
  });

  it("stops permanently after the control message", () => {
    const { processor, packets } = loadProcessor(48_000);
    processor.port.onmessage?.({ data: "stop" });

    expect(processor.process([[new Float32Array(960).fill(1)]])).toBe(false);
    expect(packets).toHaveLength(0);
  });
});
