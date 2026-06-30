import type { AudioSource, MinimalPairTerm } from "../languages/types";

let activeAudio: HTMLAudioElement | undefined;

export interface SpeechSettings {
  fallbackLang: string;
  preferredLangs?: readonly string[];
  voiceURI?: string | null;
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
  const source = sources?.[0];

  stopCurrentPlayback();

  if (source) {
    activeAudio = new Audio(resolveAudioSource(source.src));
    await activeAudio.play();
    return;
  }

  await speak(fallbackText, speech);
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
