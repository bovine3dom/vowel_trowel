import type {
  LanguageDataset,
  MinimalPairItem,
  MinimalPairTerm,
  PhonemeId,
} from "../languages/types";
import {
  countPerfectMinimalPairsForPhonemes,
  getResolvedMinimalPairsForPhonemes,
  scoreWordPairDistanceForPhonemes,
} from "../languages/resolve";
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

export interface RankedWordPair {
  id: string;
  terms: readonly [MinimalPairTerm, MinimalPairTerm];
  score: number;
}

interface RankedMinimalPair {
  item: MinimalPairItem;
  score: number;
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

const pairTieBreakers = new Map<string, Map<string, number>>();

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

  for (const contrast of dataset.contrasts) {
    const item = selectNextMinimalPairForPhonemes(dataset, contrast.phonemeIds, progress);

    if (!item) {
      continue;
    }

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
  afterItemId?: string,
): MinimalPairItem | undefined {
  const contrastId = dataset.contrasts.find((contrast) => samePhonemePair(contrast.phonemeIds, phonemeIds))?.id
    ?? createCustomContrastId(phonemeIds);
  const rankedPairs = getRankedMinimalPairsForPhonemes(dataset, phonemeIds, contrastId, true);

  if (rankedPairs.length === 0) {
    return undefined;
  }

  if (!afterItemId) {
    return rankedPairs[0]?.item;
  }

  const currentIndex = rankedPairs.findIndex((pair) => pair.item.id === afterItemId);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % rankedPairs.length : 0;

  return rankedPairs[nextIndex]?.item;
}

export function selectClosestWordPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
  limit = 8,
): RankedWordPair[] {
  const contrastId = dataset.contrasts.find((contrast) => samePhonemePair(contrast.phonemeIds, phonemeIds))?.id
    ?? createCustomContrastId(phonemeIds);

  return getRankedMinimalPairsForPhonemes(dataset, phonemeIds, contrastId, false)
    .slice(0, limit)
    .map(({ item, score }) => ({ id: item.id, terms: item.terms, score }));
}

export function countPerfectWordPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
): number {
  return countPerfectMinimalPairsForPhonemes(dataset, phonemeIds);
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

function getRankedMinimalPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
  contrastId: string,
  shuffleEqualScores: boolean,
): RankedMinimalPair[] {
  const [firstPhonemeId, secondPhonemeId] = phonemeIds;
  const tieBreakerScope = `${dataset.id}:${contrastId}:${firstPhonemeId}:${secondPhonemeId}`;

  return getResolvedMinimalPairsForPhonemes(dataset, phonemeIds, contrastId)
    .map((item): RankedMinimalPair => {
      const firstTerm = item.terms[0];
      const secondTerm = item.terms[1];
      const score = scoreWordPairDistanceForPhonemes(
        dataset,
        firstTerm.word,
        firstTerm.phonemeId,
        secondTerm.word,
        secondTerm.phonemeId,
      );

      return { item, score };
    })
    .sort((left, right) => compareRankedMinimalPairs(left, right, tieBreakerScope, shuffleEqualScores));
}

function compareRankedMinimalPairs(
  left: RankedMinimalPair,
  right: RankedMinimalPair,
  tieBreakerScope: string,
  shuffleEqualScores: boolean,
): number {
  if (left.score !== right.score) {
    return left.score - right.score;
  }

  if (shuffleEqualScores) {
    const leftTieBreaker = pairTieBreaker(tieBreakerScope, left.item.id);
    const rightTieBreaker = pairTieBreaker(tieBreakerScope, right.item.id);

    if (leftTieBreaker !== rightTieBreaker) {
      return leftTieBreaker - rightTieBreaker;
    }
  }

  return wordPairLabel(left.item).localeCompare(wordPairLabel(right.item));
}

function pairTieBreaker(scope: string, itemId: string): number {
  const scopedTieBreakers = pairTieBreakers.get(scope) ?? new Map<string, number>();
  const existing = scopedTieBreakers.get(itemId);

  if (existing !== undefined) {
    return existing;
  }

  const next = Math.random();

  scopedTieBreakers.set(itemId, next);
  pairTieBreakers.set(scope, scopedTieBreakers);

  return next;
}

function wordPairLabel(pair: { terms: readonly [MinimalPairTerm, MinimalPairTerm] }): string {
  return `${pair.terms[0].word.written}:${pair.terms[1].word.written}`;
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
