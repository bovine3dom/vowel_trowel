export type LanguageId = string;
export type PhonemeId = string;
export type ContrastId = string;
export type MinimalPairId = string;
export type WordId = string;

export type PhonemeCategory = "vowel" | "consonant" | "tone" | "other";

export interface Phoneme {
  id: PhonemeId;
  ipa: string;
  label: string;
  category: PhonemeCategory;
  audio?: readonly AudioSource[];
  notes?: string;
}

export interface PhonemeContrast {
  id: ContrastId;
  phonemeIds: readonly [PhonemeId, PhonemeId];
  label: string;
  category: PhonemeCategory;
  minimalPairs: readonly MinimalPairDefinition[];
  description?: string;
  tags?: readonly string[];
}

export type AudioSourceKind = "local" | "wiktionary" | "tts" | "external";

export interface AudioSource {
  src: string;
  kind: AudioSourceKind;
  speaker?: string;
  accent?: string;
  license?: string;
  attribution?: string;
  sourceUrl?: string;
  notes?: string;
}

export interface WordEntry {
  id: WordId;
  written: string;
  ipa: string;
  phonemeIds: readonly PhonemeId[];
  audio: readonly AudioSource[];
  speechText?: string;
  notes?: string;
}

export interface MinimalPairTermRef {
  id?: string;
  wordId: WordId;
  phonemeId: PhonemeId;
}

export interface MinimalPairDefinition {
  id: MinimalPairId;
  terms: readonly [MinimalPairTermRef, MinimalPairTermRef];
  tags?: readonly string[];
  notes?: string;
}

export interface MinimalPairTerm {
  id: string;
  wordId: WordId;
  phonemeId: PhonemeId;
  word: WordEntry;
  selectedAudio?: AudioSource;
}

export interface MinimalPairItem {
  id: MinimalPairId;
  contrastId: ContrastId;
  terms: readonly [MinimalPairTerm, MinimalPairTerm];
  tags?: readonly string[];
  notes?: string;
}

export interface LanguageDataset {
  id: LanguageId;
  name: string;
  autonym: string;
  defaultSpeechLang: string;
  speechLangs?: readonly string[];
  words: readonly WordEntry[];
  phonemes: readonly Phoneme[];
  contrasts: readonly PhonemeContrast[];
}
