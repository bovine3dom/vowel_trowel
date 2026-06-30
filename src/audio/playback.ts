import type { MinimalPairTerm } from "../languages/types";

let activeAudio: HTMLAudioElement | undefined;

export async function playTermAudio(term: MinimalPairTerm, fallbackLang: string): Promise<void> {
  const source = term.word.audio[0];

  stopCurrentPlayback();

  if (source) {
    activeAudio = new Audio(resolveAudioSource(source.src));
    await activeAudio.play();
    return;
  }

  await speak(term.word.speechText ?? term.word.written, fallbackLang);
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

function speak(text: string, lang: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) {
      reject(new Error("No recording is available and this browser does not support speech synthesis."));
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.85;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("Speech synthesis failed."));

    window.speechSynthesis.speak(utterance);
  });
}
