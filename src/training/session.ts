import type {
  LanguageDataset,
  MinimalPairItem,
  MinimalPairTerm,
  PhonemeId,
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
  const firstWord = sampleWordForPhoneme(dataset, firstPhonemeId, secondPhonemeId);
  const secondWord = sampleWordForPhoneme(dataset, secondPhonemeId, firstPhonemeId);

  if (!firstWord || !secondWord) {
    return undefined;
  }

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
) {
  const exactWords = dataset.words.filter((word) =>
    word.phonemeIds.includes(phonemeId) && !word.phonemeIds.includes(excludedPhonemeId)
  );
  const fallbackWords = exactWords.length > 0
    ? exactWords
    : dataset.words.filter((word) => word.phonemeIds.includes(phonemeId));

  return sample(fallbackWords);
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
