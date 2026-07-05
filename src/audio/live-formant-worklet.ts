import {
  estimateLiveFormants,
} from "./formants";
import { LIVE_FORMANT_ANALYSIS_HOP_SECONDS, LIVE_FORMANT_FRAME_SECONDS } from "./live-formant-config";

declare const sampleRate: number;
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

class LiveFormantProcessor extends AudioWorkletProcessor {
  private readonly sourceSampleRate = sampleRate;
  private readonly frameSampleCount = Math.max(512, Math.round(this.sourceSampleRate * LIVE_FORMANT_FRAME_SECONDS));
  private readonly hopSampleCount = Math.max(128, Math.round(this.sourceSampleRate * LIVE_FORMANT_ANALYSIS_HOP_SECONDS));
  private readonly rollingSamples = new Float32Array(this.frameSampleCount * 3);
  private rollingLength = 0;
  private totalSamples = 0;
  private lastAnalysisSample = 0;

  override process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    for (const channel of outputs[0] ?? []) {
      channel.fill(0);
    }

    const inputChannels = inputs[0];
    const input = inputChannels?.[0];

    if (!input || input.length === 0) {
      return true;
    }

    this.appendInput(input);
    this.totalSamples += input.length;

    if (
      this.rollingLength >= this.frameSampleCount
      && this.totalSamples - this.lastAnalysisSample >= this.hopSampleCount
    ) {
      this.lastAnalysisSample = this.totalSamples;
      const frame = this.rollingSamples.slice(this.rollingLength - this.frameSampleCount, this.rollingLength);
      const estimate = estimateLiveFormants(frame, this.sourceSampleRate);

      this.port.postMessage({
        type: "estimate",
        time: this.totalSamples / this.sourceSampleRate,
        f1: estimate.f1,
        f2: estimate.f2,
        energy: estimate.energy,
      });
    }

    return true;
  }

  private appendInput(input: Float32Array): void {
    if (input.length >= this.rollingSamples.length) {
      this.rollingSamples.set(input.subarray(input.length - this.rollingSamples.length));
      this.rollingLength = this.rollingSamples.length;
      return;
    }

    const overflow = Math.max(0, this.rollingLength + input.length - this.rollingSamples.length);

    if (overflow > 0) {
      this.rollingSamples.copyWithin(0, overflow, this.rollingLength);
      this.rollingLength -= overflow;
    }

    this.rollingSamples.set(input, this.rollingLength);
    this.rollingLength += input.length;
  }
}

registerProcessor("vowel-trowel-live-formants", LiveFormantProcessor);
