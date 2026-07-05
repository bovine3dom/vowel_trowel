const FORMANT_TARGET_SAMPLE_RATE = 11025;
const FORMANT_LPC_ORDER = 12;
const LIVE_FORMANT_FRAME_SECONDS = 0.04;
const LIVE_FORMANT_ANALYSIS_HOP_SECONDS = 0.025;

class LiveFormantProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.sourceSampleRate = sampleRate;
    this.frameSampleCount = Math.max(512, Math.round(this.sourceSampleRate * LIVE_FORMANT_FRAME_SECONDS));
    this.hopSampleCount = Math.max(128, Math.round(this.sourceSampleRate * LIVE_FORMANT_ANALYSIS_HOP_SECONDS));
    this.rollingSamples = new Float32Array(this.frameSampleCount * 3);
    this.rollingLength = 0;
    this.totalSamples = 0;
    this.lastAnalysisSample = 0;
  }

  process(inputs, outputs) {
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

  appendInput(input) {
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

function estimateLiveFormants(samples, sampleRate) {
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

function resampleSamples(samples, sourceSampleRate, targetSampleRate) {
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

function preEmphasizeSamples(samples) {
  const emphasized = new Float32Array(samples.length);
  let previous = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;

    emphasized[index] = sample - 0.97 * previous;
    previous = sample;
  }

  return emphasized;
}

function frameRootMeanSquare(samples, start, frameSize) {
  let total = 0;

  for (let index = 0; index < frameSize; index += 1) {
    const sample = samples[start + index] ?? 0;

    total += sample * sample;
  }

  return Math.sqrt(total / frameSize);
}

function createWindowedFrame(samples, start, frameSize, window) {
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

function createHannWindow(size) {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / Math.max(1, size - 1)));
  }

  return window;
}

function estimateFrameFormants(frame, sampleRate) {
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

function computeLpcCoefficients(frame, order) {
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

function findPolynomialRoots(coefficients) {
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

function evaluatePolynomial(coefficients, value) {
  let result = { re: coefficients[0] ?? 0, im: 0 };

  for (let index = 1; index < coefficients.length; index += 1) {
    result = addComplex(multiplyComplex(result, value), { re: coefficients[index] ?? 0, im: 0 });
  }

  return result;
}

function addComplex(left, right) {
  return { re: left.re + right.re, im: left.im + right.im };
}

function subtractComplex(left, right) {
  return { re: left.re - right.re, im: left.im - right.im };
}

function multiplyComplex(left, right) {
  return {
    re: left.re * right.re - left.im * right.im,
    im: left.re * right.im + left.im * right.re,
  };
}

function divideComplex(left, right) {
  const denominator = Math.max(1e-18, complexMagnitudeSquared(right));

  return {
    re: (left.re * right.re + left.im * right.im) / denominator,
    im: (left.im * right.re - left.re * right.im) / denominator,
  };
}

function complexMagnitudeSquared(value) {
  return value.re * value.re + value.im * value.im;
}

registerProcessor("vowel-trowel-live-formants", LiveFormantProcessor);
