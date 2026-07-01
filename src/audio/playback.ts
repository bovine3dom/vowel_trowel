import type { AudioSource, MinimalPairTerm } from "../languages/types";

let activeAudio: HTMLAudioElement | undefined;
let activeSourceNode: MediaElementAudioSourceNode | undefined;
let activeAnalyser: AnalyserNode | undefined;
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
  analyser?: AnalyserNode;
  getTiming?: () => PlaybackTiming;
  replay?: () => Promise<void>;
}

export interface PlaybackTiming {
  currentTime: number;
  duration: number | null;
}

interface PlaybackRequest {
  source?: AudioSource;
  fallbackText: string;
  speech: SpeechSettings;
}

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
): Promise<void> {
  await playAudioSources(
    term.selectedAudio ? [term.selectedAudio] : term.word.audio,
    term.word.speechText ?? term.word.written,
    speech,
  );
}

export async function playAudioSources(
  sources: readonly AudioSource[] | undefined,
  fallbackText: string,
  speech: SpeechSettings,
): Promise<void> {
  await playPlaybackRequest({
    source: sources?.[0],
    fallbackText,
    speech: cloneSpeechSettings(speech),
  });
}

async function playPlaybackRequest(request: PlaybackRequest): Promise<void> {
  const { source, fallbackText, speech } = request;

  stopCurrentPlayback();

  if (source) {
    activeAudio = new Audio(resolveAudioSource(source.src));
    activeAudio.preload = "auto";
    const sessionId = nextPlaybackSessionId();
    const getTiming = () => getAudioTiming(activeAudio);
    const replay = () => playPlaybackRequest(request);

    activeAudio.addEventListener("ended", () => {
      publishVisualizationIfCurrent(sessionId, { status: "ended" });
    }, { once: true });

    try {
      const analyser = await connectAudioAnalyser(activeAudio);

      publishVisualization({
        id: sessionId,
        mode: "recording",
        status: "playing",
        label: fallbackText,
        detail: describeAudioSource(source),
        analyser,
        getTiming,
        replay,
      });
    } catch {
      publishVisualization({
        id: sessionId,
        mode: "recording",
        status: "playing",
        label: fallbackText,
        detail: `${describeAudioSource(source)} · spectrogram unavailable`,
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

  const sessionId = nextPlaybackSessionId();
  const replay = () => playPlaybackRequest(request);

  publishVisualization({
    id: sessionId,
    mode: "voice",
    status: "playing",
    label: fallbackText,
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

  if (activeSourceNode) {
    activeSourceNode.disconnect();
    activeSourceNode = undefined;
  }

  if (activeAnalyser) {
    activeAnalyser.disconnect();
    activeAnalyser = undefined;
  }

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

async function connectAudioAnalyser(audio: HTMLAudioElement): Promise<AnalyserNode> {
  const context = getAudioContext();

  if (context.state === "suspended") {
    await context.resume();
  }

  const sourceNode = context.createMediaElementSource(audio);
  const analyser = context.createAnalyser();

  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.72;
  sourceNode.connect(analyser);
  analyser.connect(context.destination);
  activeSourceNode = sourceNode;
  activeAnalyser = analyser;

  return analyser;
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

function getAudioTiming(audio: HTMLAudioElement | undefined): PlaybackTiming {
  if (!audio) {
    return { currentTime: 0, duration: null };
  }

  return {
    currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null,
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
