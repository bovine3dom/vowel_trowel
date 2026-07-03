import type {
  LanguageDataset,
  MinimalPairItem,
  MinimalPairTerm,
  PhonemeId,
  WordEntry,
} from "../languages/types";
import { getResolvedMinimalPairs } from "../languages/resolve";
import type { AppProgress } from "../storage/progress";
import { lockTermAudio } from "./audio";

const MS_PER_HOUR = 60 * 60 * 1000;

export type PromptSlotId = string;

export interface PromptSlot {
  id: PromptSlotId;
  label: string;
  term: MinimalPairTerm;
}

export interface MatchingPrompt {
  id: string;
  item: MinimalPairItem;
  slots: readonly PromptSlot[];
  displaySlots: readonly PromptSlot[];
  wordCards: readonly MinimalPairTerm[];
}

export type PromptSelections = Record<PromptSlotId, string | null>;

export interface PromptAnswer {
  slotId: PromptSlotId;
  heardTermId: string;
  chosenTermId: string;
  heardPhonemeId: PhonemeId;
  chosenPhonemeId: PhonemeId;
  correct: boolean;
}

export interface PromptResult {
  promptId: string;
  languageId: string;
  itemId: string;
  contrastId: string;
  answers: readonly PromptAnswer[];
  correct: boolean;
  recordedAt: number;
}

export function createPromptSelections(prompt?: MatchingPrompt): PromptSelections {
  if (!prompt) {
    return {};
  }

  return Object.fromEntries(prompt.slots.map((slot) => [slot.id, null])) as PromptSelections;
}

export function selectNextMinimalPair(
  dataset: LanguageDataset,
  progress: AppProgress,
  now = Date.now(),
): MinimalPairItem | undefined {
  let best: { item: MinimalPairItem; score: number } | undefined;

  for (const item of getResolvedMinimalPairs(dataset)) {
    const score = scoreMinimalPair(dataset.id, item, progress, now);

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best?.item;
}

export function selectNextMinimalPairForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
  progress: AppProgress,
  now = Date.now(),
): MinimalPairItem | undefined {
  let best: { item: MinimalPairItem; score: number } | undefined;

  for (const item of getResolvedMinimalPairs(dataset)) {
    if (!samePhonemePair(item.terms.map((term) => term.phonemeId), phonemeIds)) {
      continue;
    }

    const score = scoreMinimalPair(dataset.id, item, progress, now);

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best?.item ?? createCustomMinimalPair(dataset, phonemeIds);
}

export function createMatchingPrompt(item: MinimalPairItem): MatchingPrompt {
  const lockedTerms = item.terms.map(lockTermAudio) as [MinimalPairTerm, MinimalPairTerm];
  const lockedItem: MinimalPairItem = { ...item, terms: lockedTerms };
  const terms = shuffleArray(lockedItem.terms);
  const slots = terms.map((term, index) => ({
    id: createSlotId(index),
    label: createSlotLabel(index),
    term,
  }));

  return {
    id: `${item.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    item: lockedItem,
    slots,
    displaySlots: shuffleArray(slots),
    wordCards: shuffleArray(lockedItem.terms),
  };
}

export function canSubmitPrompt(
  selections: PromptSelections,
  prompt?: MatchingPrompt,
): boolean {
  const values = prompt
    ? prompt.slots.map((slot) => selections[slot.id])
    : Object.values(selections);
  const chosen = values.filter((value): value is string => Boolean(value));

  return values.length > 0 && chosen.length === values.length && new Set(chosen).size === chosen.length;
}

export function gradeMatchingPrompt(
  languageId: string,
  prompt: MatchingPrompt,
  selections: PromptSelections,
  now = Date.now(),
): PromptResult | undefined {
  const answers = prompt.slots
    .map((slot) => gradeSlot(prompt, slot, selections[slot.id] ?? null))
    .filter((answer): answer is PromptAnswer => Boolean(answer));

  if (answers.length !== prompt.slots.length) {
    return undefined;
  }

  return {
    promptId: prompt.id,
    languageId,
    itemId: prompt.item.id,
    contrastId: prompt.item.contrastId,
    answers,
    correct: answers.every((answer) => answer.correct),
    recordedAt: now,
  };
}

function scoreMinimalPair(
  languageId: string,
  item: MinimalPairItem,
  progress: AppProgress,
  now: number,
): number {
  const languageProgress = progress.languages[languageId];
  const itemStats = languageProgress?.itemStats[item.id];
  const contrastStats = languageProgress?.contrastStats[item.contrastId];
  const attempts = itemStats?.attempts ?? 0;
  const accuracy = contrastStats?.attempts ? contrastStats.correct / contrastStats.attempts : 0;
  const directionScores = item.terms.map((term) => {
    const key = `${item.contrastId}:${term.phonemeId}`;
    const direction = contrastStats?.directionStats[key];

    if (!direction) {
      return 20;
    }

    if (direction.dueAt <= now) {
      return 10 + (now - direction.dueAt) / MS_PER_HOUR;
    }

    return -((direction.dueAt - now) / MS_PER_HOUR);
  });

  const weakestDirection = Math.max(...directionScores);
  const inaccuracyBoost = (1 - accuracy) * 3;
  const freshnessBoost = attempts === 0 ? 4 : 1 / Math.sqrt(attempts);

  return weakestDirection + inaccuracyBoost + freshnessBoost + Math.random() * 0.1;
}

function gradeSlot(
  prompt: MatchingPrompt,
  slot: PromptSlot,
  chosenTermId: string | null,
): PromptAnswer | undefined {
  const chosenTerm = prompt.item.terms.find((term) => term.id === chosenTermId);

  if (!chosenTerm) {
    return undefined;
  }

  return {
    slotId: slot.id,
    heardTermId: slot.term.id,
    chosenTermId: chosenTerm.id,
    heardPhonemeId: slot.term.phonemeId,
    chosenPhonemeId: chosenTerm.phonemeId,
    correct: chosenTerm.id === slot.term.id,
  };
}

function createCustomMinimalPair(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
): MinimalPairItem | undefined {
  const [firstPhonemeId, secondPhonemeId] = phonemeIds;
  const wordPair = selectClosestCustomWordPair(dataset, firstPhonemeId, secondPhonemeId);

  if (!wordPair) {
    return undefined;
  }

  const [firstWord, secondWord] = wordPair;

  return {
    id: `custom:${firstPhonemeId}:${secondPhonemeId}:${firstWord.id}:${secondWord.id}`,
    contrastId: createCustomContrastId(phonemeIds),
    terms: [
      {
        id: `${firstPhonemeId}:${firstWord.id}`,
        wordId: firstWord.id,
        phonemeId: firstPhonemeId,
        word: firstWord,
      },
      {
        id: `${secondPhonemeId}:${secondWord.id}`,
        wordId: secondWord.id,
        phonemeId: secondPhonemeId,
        word: secondWord,
      },
    ],
    tags: ["custom"],
  };
}

function sampleWordForPhoneme(
  dataset: LanguageDataset,
  phonemeId: PhonemeId,
  excludedPhonemeId: PhonemeId,
): WordEntry | undefined {
  return sample(candidateWordsForPhoneme(dataset, phonemeId, excludedPhonemeId));
}

function selectClosestCustomWordPair(
  dataset: LanguageDataset,
  firstPhonemeId: PhonemeId,
  secondPhonemeId: PhonemeId,
): readonly [WordEntry, WordEntry] | undefined {
  const firstWords = candidateWordsForPhoneme(dataset, firstPhonemeId, secondPhonemeId);
  const secondWords = candidateWordsForPhoneme(dataset, secondPhonemeId, firstPhonemeId);
  const firstPhonemeIpa = phonemeIpa(dataset, firstPhonemeId);
  const secondPhonemeIpa = phonemeIpa(dataset, secondPhonemeId);

  if (firstWords.length === 0 || secondWords.length === 0) {
    return undefined;
  }

  if (!firstPhonemeIpa || !secondPhonemeIpa) {
    const firstWord = sampleWordForPhoneme(dataset, firstPhonemeId, secondPhonemeId);
    const secondWord = sampleWordForPhoneme(dataset, secondPhonemeId, firstPhonemeId);

    return firstWord && secondWord ? [firstWord, secondWord] : undefined;
  }

  let best: { words: readonly [WordEntry, WordEntry]; score: number } | undefined;

  for (const firstWord of firstWords) {
    const firstShell = ipaShell(firstWord.ipa, firstPhonemeIpa);

    for (const secondWord of secondWords) {
      const secondShell = ipaShell(secondWord.ipa, secondPhonemeIpa);
      const score = firstShell && secondShell
        ? levenshteinDistance(firstShell, secondShell)
        : Number.POSITIVE_INFINITY;

      if (!best || score < best.score || (score === best.score && Math.random() < 0.5)) {
        best = { words: [firstWord, secondWord], score };
      }
    }
  }

  if (best && Number.isFinite(best.score)) {
    return best.words;
  }

  const firstWord = sample(firstWords);
  const secondWord = sample(secondWords);

  return firstWord && secondWord ? [firstWord, secondWord] : undefined;
}

function candidateWordsForPhoneme(
  dataset: LanguageDataset,
  phonemeId: PhonemeId,
  excludedPhonemeId: PhonemeId,
): WordEntry[] {
  const exactWords = dataset.words.filter((word) =>
    word.phonemeIds.includes(phonemeId) && !word.phonemeIds.includes(excludedPhonemeId)
  );

  return exactWords.length > 0
    ? exactWords
    : dataset.words.filter((word) => word.phonemeIds.includes(phonemeId));
}

function phonemeIpa(dataset: LanguageDataset, phonemeId: PhonemeId): string | undefined {
  return dataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.ipa;
}

function ipaShell(wordIpa: string, targetPhonemeIpa: string): string {
  const word = normalizeIpaText(wordIpa);
  const target = normalizeIpaText(targetPhonemeIpa);

  return target ? word.replace(target, "") : word;
}

function normalizeIpaText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\/\[\]]/g, "")
    .replace(/[ˈˌ.\s]/g, "");
}

function levenshteinDistance(left: string, right: string): number {
  const leftSymbols = [...left];
  const rightSymbols = [...right];
  const previous = Array.from({ length: rightSymbols.length + 1 }, (_, index) => index);
  const current = Array.from({ length: rightSymbols.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= leftSymbols.length; leftIndex += 1) {
    current[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= rightSymbols.length; rightIndex += 1) {
      const substitutionCost = leftSymbols[leftIndex - 1] === rightSymbols[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitutionCost,
      );
    }

    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[rightSymbols.length] ?? 0;
}

function samePhonemePair(
  left: readonly PhonemeId[],
  right: readonly [PhonemeId, PhonemeId],
): boolean {
  return left.length === 2
    && left.includes(right[0])
    && left.includes(right[1])
    && right[0] !== right[1];
}

function createCustomContrastId(phonemeIds: readonly [PhonemeId, PhonemeId]): string {
  return `custom:${phonemeIds[0]}:${phonemeIds[1]}`;
}

function sample<T>(items: readonly T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)];
}

function createSlotId(index: number): PromptSlotId {
  return `slot-${index + 1}`;
}

function createSlotLabel(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function shuffleArray<T>(items: readonly T[]): T[] {
  const shuffled = [...items];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];

    if (current !== undefined && swap !== undefined) {
      shuffled[index] = swap;
      shuffled[swapIndex] = current;
    }
  }

  return shuffled;
}
