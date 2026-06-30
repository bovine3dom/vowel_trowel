import type {
  LanguageDataset,
  MinimalPairItem,
  MinimalPairTerm,
  PhonemeId,
} from "../languages/types";
import type { AppProgress } from "../storage/progress";

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

  for (const item of dataset.minimalPairs) {
    const score = scoreMinimalPair(dataset.id, item, progress, now);

    if (!best || score > best.score) {
      best = { item, score };
    }
  }

  return best?.item;
}

export function createMatchingPrompt(item: MinimalPairItem): MatchingPrompt {
  const terms = shuffleArray(item.terms);
  const slots = terms.map((term, index) => ({
    id: createSlotId(index),
    label: createSlotLabel(index),
    term,
  }));

  return {
    id: `${item.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    item,
    slots,
    displaySlots: shuffleArray(slots),
    wordCards: shuffleArray(item.terms),
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
