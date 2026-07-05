import type { AudioSource, MinimalPairTerm } from "../languages/types";
import {
  computeFormantTrack,
  createHannWindow,
  mixAudioBufferToMono,
  type FormantTrack,
} from "./formants";
export {
  estimateLiveFormants,
  type FormantPoint,
  type FormantTrack,
  type LiveFormantEstimate,
} from "./formants";
import { resolveAudioSource } from "./sources";

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

export async function getPrecomputedSpectrogram(audioUrl: string): Promise<PrecomputedSpectrogram> {
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
