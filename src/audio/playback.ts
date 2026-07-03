import type { AudioSource, MinimalPairTerm } from "../languages/types";

let activeAudio: HTMLAudioElement | undefined;
let sharedAudioContext: AudioContext | undefined;
let playbackSessionId = 0;

export type PlaybackVisualizationMode = "idle" | "recording" | "voice";
export type PlaybackVisualizationStatus = "idle" | "playing" | "ended" | "error";

export interface PlaybackVisualizationState {
  id: number;
  mode: PlaybackVisualizationMode;
  status: PlaybackVisualizationStatus;
  label: string;
  detail?: string;
  feedbackPath?: string;
  spectrogram?: PrecomputedSpectrogram;
  getTiming?: () => PlaybackTiming;
  replay?: () => Promise<void>;
}

export interface PrecomputedSpectrogram {
  data: Uint8Array;
  columnCount: number;
  binCount: number;
  duration: number;
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  formants?: FormantTrack;
}

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

export interface PlaybackTiming {
  currentTime: number;
  duration: number | null;
}

interface PlaybackRequest {
  source?: AudioSource;
  fallbackText: string;
  visualizationLabel?: string;
  feedbackPath?: string;
  speech: SpeechSettings;
}

const SPECTROGRAM_FFT_SIZE = 512;
const SPECTROGRAM_HOP_SIZE = 64;
const SPECTROGRAM_DYNAMIC_RANGE_DB = 70;
const FORMANT_TARGET_SAMPLE_RATE = 11025;
const FORMANT_FRAME_SECONDS = 0.03;
const FORMANT_HOP_SECONDS = 0.01;
const FORMANT_LPC_ORDER = 12;
const FORMANT_MIN_VALID_POINTS = 3;
const FORMANT_DISPLAY_MAX_HZ = 4000;
const spectrogramCache = new Map<string, Promise<PrecomputedSpectrogram>>();

const visualizationListeners = new Set<(state: PlaybackVisualizationState) => void>();
let visualizationState: PlaybackVisualizationState = {
  id: playbackSessionId,
  mode: "idle",
  status: "idle",
  label: "Ready",
  detail: "Play a recording to draw a spectrogram.",
};

export interface SpeechSettings {
  fallbackLang: string;
  preferredLangs?: readonly string[];
  voiceURI?: string | null;
  ttsEnabled?: boolean;
}

export function getPlaybackVisualizationState(): PlaybackVisualizationState {
  return visualizationState;
}

export function subscribePlaybackVisualization(
  listener: (state: PlaybackVisualizationState) => void,
): () => void {
  visualizationListeners.add(listener);
  listener(visualizationState);

  return () => visualizationListeners.delete(listener);
}

export async function playTermAudio(
  term: MinimalPairTerm,
  speech: SpeechSettings,
  visualizationLabel?: string,
  feedbackPath?: string,
): Promise<void> {
  await playAudioSources(
    term.selectedAudio ? [term.selectedAudio] : term.word.audio,
    term.word.speechText ?? term.word.written,
    speech,
    visualizationLabel,
    feedbackPath,
  );
}

export async function playAudioSources(
  sources: readonly AudioSource[] | undefined,
  fallbackText: string,
  speech: SpeechSettings,
  visualizationLabel?: string,
  feedbackPath?: string,
): Promise<void> {
  await playPlaybackRequest({
    source: sources?.[0],
    fallbackText,
    visualizationLabel,
    feedbackPath,
    speech: cloneSpeechSettings(speech),
  });
}

async function playPlaybackRequest(request: PlaybackRequest): Promise<void> {
  const { source, fallbackText, visualizationLabel, feedbackPath, speech } = request;
  const displayLabel = visualizationLabel ?? fallbackText;

  stopCurrentPlayback();

  if (source) {
    const audioUrl = resolveAudioSource(source.src);
    activeAudio = new Audio(audioUrl);
    activeAudio.preload = "auto";
    const sessionId = nextPlaybackSessionId();
    let durationHint: number | null = null;
    const getTiming = () => getAudioTiming(activeAudio, durationHint);
    const replay = () => playPlaybackRequest(request);

    activeAudio.addEventListener("ended", () => {
      publishVisualizationIfCurrent(sessionId, { status: "ended" });
    }, { once: true });

    try {
      const spectrogram = await getPrecomputedSpectrogram(audioUrl);
      durationHint = spectrogram.duration;

      publishVisualization({
        id: sessionId,
        mode: "recording",
        status: "playing",
        label: displayLabel,
        detail: describeAudioSource(source),
        feedbackPath,
        spectrogram,
        getTiming,
        replay,
      });
    } catch {
      publishVisualization({
        id: sessionId,
        mode: "recording",
        status: "playing",
        label: displayLabel,
        detail: `${describeAudioSource(source)} · spectrogram unavailable`,
        feedbackPath,
        getTiming,
        replay,
      });
    }

    try {
      await activeAudio.play();
    } catch (error) {
      publishVisualizationIfCurrent(sessionId, {
        status: "error",
        detail: error instanceof Error ? error.message : "Audio playback failed.",
      });
      throw error;
    }

    return;
  }

  if (!speech.ttsEnabled) {
    throw new Error("No recording is available for this item.");
  }

  const sessionId = nextPlaybackSessionId();
  const replay = () => playPlaybackRequest(request);

  publishVisualization({
    id: sessionId,
    mode: "voice",
    status: "playing",
    label: displayLabel,
    detail: "Browser voice fallback. A real spectrogram is available for recordings.",
    replay,
  });

  try {
    await speak(fallbackText, speech);
    publishVisualizationIfCurrent(sessionId, { status: "ended" });
  } catch (error) {
    publishVisualizationIfCurrent(sessionId, {
      status: "error",
      detail: error instanceof Error ? error.message : "Speech synthesis failed.",
    });
    throw error;
  }
}

export function getAvailableSpeechVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return [];
  }

  return window.speechSynthesis.getVoices();
}

export function selectSpeechVoice(
  voices: readonly SpeechSynthesisVoice[],
  settings: SpeechSettings,
): SpeechSynthesisVoice | undefined {
  if (settings.voiceURI) {
    const explicitVoice = voices.find((voice) => voice.voiceURI === settings.voiceURI);

    if (explicitVoice) {
      return explicitVoice;
    }
  }

  const preferredLangs = settings.preferredLangs?.length
    ? settings.preferredLangs
    : [settings.fallbackLang];

  for (const lang of preferredLangs) {
    const exactVoice = voices.find((voice) => sameLang(voice.lang, lang));

    if (exactVoice) {
      return exactVoice;
    }
  }

  for (const lang of preferredLangs) {
    const regionalVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith(lang.toLowerCase()));

    if (regionalVoice) {
      return regionalVoice;
    }
  }

  return voices.find((voice) => voice.lang.toLowerCase().startsWith(settings.fallbackLang.toLowerCase()));
}

function stopCurrentPlayback(): void {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    activeAudio = undefined;
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

async function getPrecomputedSpectrogram(audioUrl: string): Promise<PrecomputedSpectrogram> {
  const cached = spectrogramCache.get(audioUrl);

  if (cached) {
    return cached;
  }

  const promise = createPrecomputedSpectrogram(audioUrl);
  spectrogramCache.set(audioUrl, promise);

  try {
    return await promise;
  } catch (error) {
    spectrogramCache.delete(audioUrl);
    throw error;
  }
}

async function createPrecomputedSpectrogram(audioUrl: string): Promise<PrecomputedSpectrogram> {
  const context = getAudioContext();

  if (context.state === "suspended") {
    await context.resume();
  }

  const response = await fetch(audioUrl);

  if (!response.ok) {
    throw new Error(`Could not fetch audio for spectrogram: HTTP ${response.status}`);
  }

  const audioBuffer = await context.decodeAudioData(await response.arrayBuffer());

  const spectrogram = computeSpectrogram(audioBuffer, SPECTROGRAM_FFT_SIZE, SPECTROGRAM_HOP_SIZE);
  const formants = computeFormantTrack(audioBuffer);

  return formants ? { ...spectrogram, formants } : spectrogram;
}

function computeSpectrogram(
  audioBuffer: AudioBuffer,
  fftSize: number,
  hopSize: number,
): PrecomputedSpectrogram {
  const samples = mixAudioBufferToMono(audioBuffer);
  const columnCount = Math.max(1, Math.ceil(samples.length / hopSize));
  const binCount = fftSize / 2;
  const magnitudes = new Float32Array(columnCount * binCount);
  const window = createHannWindow(fftSize);
  let maxDb = -Infinity;

  for (let column = 0; column < columnCount; column += 1) {
    const start = column * hopSize;
    const real = new Float32Array(fftSize);
    const imaginary = new Float32Array(fftSize);

    for (let index = 0; index < fftSize; index += 1) {
      real[index] = (samples[start + index] ?? 0) * (window[index] ?? 0);
    }

    fft(real, imaginary);

    for (let bin = 0; bin < binCount; bin += 1) {
      const magnitude = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0) / fftSize;
      const db = 20 * Math.log10(magnitude + 1e-8);

      magnitudes[column * binCount + bin] = db;
      maxDb = Math.max(maxDb, db);
    }
  }

  const floorDb = maxDb - SPECTROGRAM_DYNAMIC_RANGE_DB;
  const data = new Uint8Array(magnitudes.length);

  for (let index = 0; index < magnitudes.length; index += 1) {
    data[index] = Math.round(
      Math.max(0, Math.min(1, ((magnitudes[index] ?? floorDb) - floorDb) / SPECTROGRAM_DYNAMIC_RANGE_DB)) * 255,
    );
  }

  return {
    data,
    columnCount,
    binCount,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    fftSize,
    hopSize,
  };
}

function mixAudioBufferToMono(audioBuffer: AudioBuffer): Float32Array {
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

function computeFormantTrack(audioBuffer: AudioBuffer): FormantTrack | undefined {
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

function createHannWindow(size: number): Float32Array {
  const window = new Float32Array(size);

  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / Math.max(1, size - 1)));
  }

  return window;
}

function fft(real: Float32Array, imaginary: Float32Array): void {
  const size = real.length;
  let reversed = 0;

  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;

    for (; reversed & bit; bit >>= 1) {
      reversed ^= bit;
    }

    reversed ^= bit;

    if (index < reversed) {
      const realValue = real[index] ?? 0;
      real[index] = real[reversed] ?? 0;
      real[reversed] = realValue;

      const imaginaryValue = imaginary[index] ?? 0;
      imaginary[index] = imaginary[reversed] ?? 0;
      imaginary[reversed] = imaginaryValue;
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wLengthReal = Math.cos(angle);
    const wLengthImaginary = Math.sin(angle);

    for (let index = 0; index < size; index += length) {
      let wReal = 1;
      let wImaginary = 0;

      for (let offset = 0; offset < length / 2; offset += 1) {
        const evenIndex = index + offset;
        const oddIndex = evenIndex + length / 2;
        const oddReal = (real[oddIndex] ?? 0) * wReal - (imaginary[oddIndex] ?? 0) * wImaginary;
        const oddImaginary = (real[oddIndex] ?? 0) * wImaginary + (imaginary[oddIndex] ?? 0) * wReal;
        const evenReal = real[evenIndex] ?? 0;
        const evenImaginary = imaginary[evenIndex] ?? 0;

        real[evenIndex] = evenReal + oddReal;
        imaginary[evenIndex] = evenImaginary + oddImaginary;
        real[oddIndex] = evenReal - oddReal;
        imaginary[oddIndex] = evenImaginary - oddImaginary;

        const nextWReal = wReal * wLengthReal - wImaginary * wLengthImaginary;
        wImaginary = wReal * wLengthImaginary + wImaginary * wLengthReal;
        wReal = nextWReal;
      }
    }
  }
}

function getAudioContext(): AudioContext {
  if (sharedAudioContext) {
    return sharedAudioContext;
  }

  const AudioContextConstructor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextConstructor) {
    throw new Error("Web Audio is not available in this browser.");
  }

  sharedAudioContext = new AudioContextConstructor();

  return sharedAudioContext;
}

function getAudioTiming(audio: HTMLAudioElement | undefined, durationHint: number | null): PlaybackTiming {
  if (!audio) {
    return { currentTime: 0, duration: durationHint };
  }

  return {
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : durationHint,
  };
}

function cloneSpeechSettings(settings: SpeechSettings): SpeechSettings {
  return {
    fallbackLang: settings.fallbackLang,
    preferredLangs: settings.preferredLangs ? [...settings.preferredLangs] : undefined,
    voiceURI: settings.voiceURI,
  };
}

function nextPlaybackSessionId(): number {
  playbackSessionId += 1;

  return playbackSessionId;
}

function publishVisualization(state: PlaybackVisualizationState): void {
  visualizationState = state;

  for (const listener of visualizationListeners) {
    listener(visualizationState);
  }
}

function publishVisualizationIfCurrent(
  id: number,
  patch: Partial<Omit<PlaybackVisualizationState, "id">>,
): void {
  if (visualizationState.id !== id) {
    return;
  }

  publishVisualization({ ...visualizationState, ...patch, id });
}

function describeAudioSource(source: AudioSource): string {
  return [source.accent, source.speaker, source.license, source.kind]
    .filter(Boolean)
    .join(" · ") || "Recording";
}

function resolveAudioSource(src: string): string {
  if (/^(https?:|data:|blob:|\/)/.test(src)) {
    return src;
  }

  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;

  return `${normalizedBase}${src}`;
}

function speak(text: string, settings: SpeechSettings): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("No recording is available and this browser does not support speech synthesis."));
      return;
    }

    const voice = selectSpeechVoice(window.speechSynthesis.getVoices(), settings);
    const utterance = new SpeechSynthesisUtterance(text);

    utterance.lang = voice?.lang ?? settings.fallbackLang;
    utterance.voice = voice ?? null;
    utterance.rate = 0.85;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("Speech synthesis failed."));

    window.speechSynthesis.speak(utterance);
  });
}

function sameLang(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
