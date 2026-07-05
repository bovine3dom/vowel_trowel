export const LIVE_FORMANT_FRAME_SECONDS = 0.04;
export const LIVE_FORMANT_ANALYSIS_HOP_SECONDS = 0.025;
export const LIVE_FORMANT_ANALYSIS_HOP_MS = LIVE_FORMANT_ANALYSIS_HOP_SECONDS * 1000;

const FORMANT_TARGET_SAMPLE_RATE = 11025;
const FORMANT_FRAME_SECONDS = 0.03;
const FORMANT_HOP_SECONDS = 0.01;
const FORMANT_LPC_ORDER = 12;
const FORMANT_MIN_VALID_POINTS = 3;
const FORMANT_DISPLAY_MAX_HZ = 4000;

export interface FormantTrack {
  points: FormantPoint[];
  duration: number;
  minHz: number;
  maxHz: number;
}

export interface FormantPoint {
  time: number;
  f1: number | null;
  f2: number | null;
  energy: number;
}

export interface LiveFormantEstimate {
  f1: number | null;
  f2: number | null;
  energy: number;
}

export function estimateLiveFormants(samples: Float32Array, sampleRate: number): LiveFormantEstimate {
  if (samples.length < 128 || sampleRate <= 0) {
    return { f1: null, f2: null, energy: 0 };
  }

  const targetSampleRate = Math.min(sampleRate, FORMANT_TARGET_SAMPLE_RATE);
  const resampled = resampleSamples(samples, sampleRate, targetSampleRate);
  const energy = frameRootMeanSquare(resampled, 0, resampled.length);

  if (resampled.length < 128 || energy < 0.004) {
    return { f1: null, f2: null, energy };
  }

  const emphasized = preEmphasizeSamples(resampled);
  const frame = createWindowedFrame(emphasized, 0, emphasized.length, createHannWindow(emphasized.length));
  const estimate = estimateFrameFormants(frame, targetSampleRate);

  return { ...estimate, energy };
}

export function computeFormantTrack(audioBuffer: AudioBuffer): FormantTrack | undefined {
  const monoSamples = mixAudioBufferToMono(audioBuffer);
  const targetSampleRate = Math.min(audioBuffer.sampleRate, FORMANT_TARGET_SAMPLE_RATE);
  const samples = preEmphasizeSamples(resampleSamples(monoSamples, audioBuffer.sampleRate, targetSampleRate));
  const frameSize = Math.max(128, Math.round(targetSampleRate * FORMANT_FRAME_SECONDS));
  const hopSize = Math.max(64, Math.round(targetSampleRate * FORMANT_HOP_SECONDS));

  if (samples.length < frameSize) {
    return undefined;
  }

  const frameCount = Math.max(1, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const window = createHannWindow(frameSize);
  const frameRms = new Float32Array(frameCount);
  let maxRms = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const rms = frameRootMeanSquare(samples, frameIndex * hopSize, frameSize);

    frameRms[frameIndex] = rms;
    maxRms = Math.max(maxRms, rms);
  }

  if (maxRms <= 0) {
    return undefined;
  }

  const minimumRms = Math.max(0.002, maxRms * 0.08);
  const points: FormantPoint[] = [];
  let validPointCount = 0;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const start = frameIndex * hopSize;
    const time = (start + frameSize / 2) / targetSampleRate;
    const energy = Math.min(1, (frameRms[frameIndex] ?? 0) / maxRms);

    if ((frameRms[frameIndex] ?? 0) < minimumRms) {
      points.push({ time, f1: null, f2: null, energy });
      continue;
    }

    const frame = createWindowedFrame(samples, start, frameSize, window);
    const estimate = estimateFrameFormants(frame, targetSampleRate);

    if (estimate.f1 !== null || estimate.f2 !== null) {
      validPointCount += 1;
    }

    points.push({ time, f1: estimate.f1, f2: estimate.f2, energy });
  }

  if (validPointCount < FORMANT_MIN_VALID_POINTS) {
    return undefined;
  }

  return {
    points: smoothFormantPoints(points),
    duration: audioBuffer.duration,
    minHz: 0,
    maxHz: Math.min(FORMANT_DISPLAY_MAX_HZ, targetSampleRate / 2),
  };
}

export function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const samples = new Float32Array(audioBuffer.length);
  const channels = Math.max(1, audioBuffer.numberOfChannels);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = audioBuffer.getChannelData(channel);

    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (samples[index] ?? 0) + (data[index] ?? 0) / channels;
    }
  }

  return samples;
}

export function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / Math.max(1, size - 1)));
  }

  return window;
}

function resampleSamples(samples: Float32Array, sourceSampleRate: number, targetSampleRate: number): Float32Array {
  if (Math.abs(sourceSampleRate - targetSampleRate) < 1) {
    return samples;
  }

  const ratio = sourceSampleRate / targetSampleRate;
  const targetLength = Math.max(1, Math.floor(samples.length / ratio));
  const resampled = new Float32Array(targetLength);

  for (let index = 0; index < targetLength; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const amount = sourceIndex - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;

    resampled[index] = left + (right - left) * amount;
  }

  return resampled;
}

function preEmphasizeSamples(samples: Float32Array): Float32Array {
  const emphasized = new Float32Array(samples.length);
  let previous = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;

    emphasized[index] = sample - 0.97 * previous;
    previous = sample;
  }

  return emphasized;
}

function frameRootMeanSquare(samples: Float32Array, start: number, frameSize: number): number {
  let total = 0;

  for (let index = 0; index < frameSize; index += 1) {
    const sample = samples[start + index] ?? 0;

    total += sample * sample;
  }

  return Math.sqrt(total / frameSize);
}

function createWindowedFrame(
  samples: Float32Array,
  start: number,
  frameSize: number,
  window: Float32Array,
): Float32Array {
  const frame = new Float32Array(frameSize);
  let mean = 0;

  for (let index = 0; index < frameSize; index += 1) {
    mean += samples[start + index] ?? 0;
  }

  mean /= frameSize;

  for (let index = 0; index < frameSize; index += 1) {
    frame[index] = ((samples[start + index] ?? 0) - mean) * (window[index] ?? 0);
  }

  return frame;
}

function estimateFrameFormants(frame: Float32Array, sampleRate: number): { f1: number | null; f2: number | null } {
  const coefficients = computeLpcCoefficients(frame, FORMANT_LPC_ORDER);

  if (!coefficients) {
    return { f1: null, f2: null };
  }

  const roots = findPolynomialRoots(Array.from(coefficients));
  const nyquist = sampleRate / 2;
  const candidates = roots
    .filter((root) => root.im > 0.001)
    .map((root) => {
      const radius = Math.hypot(root.re, root.im);
      const frequency = Math.atan2(root.im, root.re) * sampleRate / (2 * Math.PI);
      const bandwidth = radius > 0
        ? -0.5 * sampleRate * Math.log(Math.max(1e-6, radius)) / Math.PI
        : Infinity;

      return { frequency, bandwidth, radius };
    })
    .filter((candidate) =>
      Number.isFinite(candidate.frequency)
      && Number.isFinite(candidate.bandwidth)
      && candidate.frequency >= 150
      && candidate.frequency <= Math.min(4500, nyquist - 50)
      && candidate.bandwidth >= 20
      && candidate.bandwidth <= 900
      && candidate.radius > 0.05
    )
    .sort((left, right) => left.frequency - right.frequency);
  const f1 = candidates.find((candidate) => candidate.frequency >= 180 && candidate.frequency <= 1200)?.frequency ?? null;
  const f2 = candidates.find((candidate) =>
    candidate.frequency >= Math.max(550, (f1 ?? 0) + 250)
    && candidate.frequency <= 3500
  )?.frequency ?? null;

  return {
    f1: f1 === null ? null : Math.round(f1),
    f2: f2 === null ? null : Math.round(f2),
  };
}

function computeLpcCoefficients(frame: Float32Array, order: number): Float64Array | undefined {
  const autocorrelation = new Float64Array(order + 1);

  for (let lag = 0; lag <= order; lag += 1) {
    let total = 0;

    for (let index = 0; index < frame.length - lag; index += 1) {
      total += (frame[index] ?? 0) * (frame[index + lag] ?? 0);
    }

    autocorrelation[lag] = total;
  }

  if ((autocorrelation[0] ?? 0) <= 1e-10) {
    return undefined;
  }

  const coefficients = new Float64Array(order + 1);
  const previous = new Float64Array(order + 1);
  coefficients[0] = 1;
  let error = autocorrelation[0] ?? 0;

  for (let index = 1; index <= order; index += 1) {
    let accumulator = autocorrelation[index] ?? 0;

    for (let offset = 1; offset < index; offset += 1) {
      accumulator += (coefficients[offset] ?? 0) * (autocorrelation[index - offset] ?? 0);
    }

    const reflection = -accumulator / Math.max(error, 1e-12);

    if (!Number.isFinite(reflection) || Math.abs(reflection) >= 0.999) {
      return undefined;
    }

    previous.set(coefficients);
    coefficients[index] = reflection;

    for (let offset = 1; offset < index; offset += 1) {
      coefficients[offset] = (previous[offset] ?? 0) + reflection * (previous[index - offset] ?? 0);
    }

    error *= 1 - reflection * reflection;

    if (!Number.isFinite(error) || error <= 1e-12) {
      return undefined;
    }
  }

  return coefficients;
}

interface ComplexNumber {
  re: number;
  im: number;
}

function findPolynomialRoots(coefficients: readonly number[]): ComplexNumber[] {
  const degree = coefficients.length - 1;

  if (degree <= 0) {
    return [];
  }

  const leading = coefficients[0] ?? 1;
  const normalizedCoefficients = coefficients.map((coefficient) => coefficient / leading);
  const roots = Array.from({ length: degree }, (_, index) => {
    const angle = (2 * Math.PI * index) / degree + 0.18;

    return { re: 0.72 * Math.cos(angle), im: 0.72 * Math.sin(angle) };
  });

  for (let iteration = 0; iteration < 60; iteration += 1) {
    let maxDelta = 0;

    for (let index = 0; index < degree; index += 1) {
      const root = roots[index] ?? { re: 0, im: 0 };
      let denominator = { re: 1, im: 0 };

      for (let otherIndex = 0; otherIndex < degree; otherIndex += 1) {
        if (otherIndex === index) {
          continue;
        }

        denominator = multiplyComplex(denominator, subtractComplex(root, roots[otherIndex] ?? root));
      }

      if (complexMagnitudeSquared(denominator) < 1e-18) {
        continue;
      }

      const value = evaluatePolynomial(normalizedCoefficients, root);
      const delta = divideComplex(value, denominator);

      roots[index] = subtractComplex(root, delta);
      maxDelta = Math.max(maxDelta, Math.hypot(delta.re, delta.im));
    }

    if (maxDelta < 1e-7) {
      break;
    }
  }

  return roots;
}

function evaluatePolynomial(coefficients: readonly number[], value: ComplexNumber): ComplexNumber {
  let result = { re: coefficients[0] ?? 0, im: 0 };

  for (let index = 1; index < coefficients.length; index += 1) {
    result = addComplex(multiplyComplex(result, value), { re: coefficients[index] ?? 0, im: 0 });
  }

  return result;
}

function addComplex(left: ComplexNumber, right: ComplexNumber): ComplexNumber {
  return { re: left.re + right.re, im: left.im + right.im };
}

function subtractComplex(left: ComplexNumber, right: ComplexNumber): ComplexNumber {
  return { re: left.re - right.re, im: left.im - right.im };
}

function multiplyComplex(left: ComplexNumber, right: ComplexNumber): ComplexNumber {
  return {
    re: left.re * right.re - left.im * right.im,
    im: left.re * right.im + left.im * right.re,
  };
}

function divideComplex(left: ComplexNumber, right: ComplexNumber): ComplexNumber {
  const denominator = Math.max(1e-18, complexMagnitudeSquared(right));

  return {
    re: (left.re * right.re + left.im * right.im) / denominator,
    im: (left.im * right.re - left.re * right.im) / denominator,
  };
}

function complexMagnitudeSquared(value: ComplexNumber): number {
  return value.re * value.re + value.im * value.im;
}

function smoothFormantPoints(points: readonly FormantPoint[]): FormantPoint[] {
  const f1 = smoothNullableSeries(points.map((point) => point.f1));
  const f2 = smoothNullableSeries(points.map((point) => point.f2));

  return points.map((point, index) => ({
    ...point,
    f1: f1[index] ?? null,
    f2: f2[index] ?? null,
  }));
}

function smoothNullableSeries(values: readonly (number | null)[]): (number | null)[] {
  const medianed = values.map((value, index) => {
    if (value === null) {
      return null;
    }

    const neighbors = values
      .slice(Math.max(0, index - 1), Math.min(values.length, index + 2))
      .filter((candidate): candidate is number => candidate !== null)
      .sort((left, right) => left - right);

    return neighbors[Math.floor(neighbors.length / 2)] ?? value;
  });
  const smoothed: (number | null)[] = [];
  let previous: number | null = null;

  for (const value of medianed) {
    if (value === null) {
      smoothed.push(null);
      previous = null;
      continue;
    }

    const nextValue: number = previous === null ? value : previous * 0.55 + value * 0.45;

    smoothed.push(Math.round(nextValue));
    previous = nextValue;
  }

  return smoothed;
}
