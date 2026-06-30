import type { LanguageDataset, MinimalPairTerm, PhonemeId } from "../languages/types";
import { getWordsForContrastPhoneme } from "../languages/resolve";
import type { AppProgress } from "../storage/progress";
import type { PromptAnswer, PromptResult } from "./session";
import { selectNextMinimalPair } from "./session";
import { lockTermAudio } from "./audio";

export interface SortingGroup {
  id: PhonemeId;
  phonemeId: PhonemeId;
  label: string;
  exampleTerm: MinimalPairTerm;
}

export interface SortingPrompt {
  id: string;
  contrastId: string;
  groups: readonly SortingGroup[];
  wordCards: readonly MinimalPairTerm[];
}

export type SortingPlacements = Record<string, PhonemeId | null>;

export function selectNextSortingPrompt(
  dataset: LanguageDataset,
  progress: AppProgress,
): SortingPrompt | undefined {
  const preferredItem = selectNextMinimalPair(dataset, progress);
  const preferredPrompt = preferredItem
    ? createSortingPrompt(dataset, preferredItem.contrastId)
    : undefined;

  if (preferredPrompt) {
    return preferredPrompt;
  }

  for (const contrast of dataset.contrasts) {
    const prompt = createSortingPrompt(dataset, contrast.id);

    if (prompt) {
      return prompt;
    }
  }

  return undefined;
}

export function createSortingPlacements(prompt?: SortingPrompt): SortingPlacements {
  if (!prompt) {
    return {};
  }

  return Object.fromEntries(prompt.wordCards.map((term) => [term.id, null]));
}

export function canSubmitSortingPrompt(
  placements: SortingPlacements,
  prompt: SortingPrompt,
): boolean {
  return prompt.wordCards.every((term) => Boolean(placements[term.id]));
}

export function gradeSortingPrompt(
  languageId: string,
  prompt: SortingPrompt,
  placements: SortingPlacements,
  now = Date.now(),
): PromptResult | undefined {
  if (!canSubmitSortingPrompt(placements, prompt)) {
    return undefined;
  }

  const answers = prompt.wordCards.map((term): PromptAnswer => {
    const chosenPhonemeId = placements[term.id] ?? "";

    return {
      slotId: term.id,
      heardTermId: term.id,
      chosenTermId: chosenPhonemeId,
      heardPhonemeId: term.phonemeId,
      chosenPhonemeId,
      correct: term.phonemeId === chosenPhonemeId,
    };
  });

  return {
    promptId: prompt.id,
    languageId,
    itemId: `sort:${prompt.contrastId}`,
    contrastId: prompt.contrastId,
    answers,
    correct: answers.every((answer) => answer.correct),
    recordedAt: now,
  };
}

function createSortingPrompt(
  dataset: LanguageDataset,
  contrastId: string,
): SortingPrompt | undefined {
  const contrast = dataset.contrasts.find((candidate) => candidate.id === contrastId);

  if (!contrast) {
    return undefined;
  }

  const termsByPhoneme = new Map<PhonemeId, MinimalPairTerm[]>();

  for (const phonemeId of contrast.phonemeIds) {
    termsByPhoneme.set(phonemeId, getWordsForContrastPhoneme(dataset, contrast, phonemeId));
  }

  const lockedTermsById = new Map<string, MinimalPairTerm>();

  for (const terms of termsByPhoneme.values()) {
    for (const term of terms) {
      lockedTermsById.set(term.id, lockedTermsById.get(term.id) ?? lockTermAudio(term));
    }
  }

  const groups = contrast.phonemeIds.flatMap((phonemeId) => {
    const phoneme = dataset.phonemes.find((candidate) => candidate.id === phonemeId);
    const exampleTerm = termsByPhoneme.get(phonemeId)?.[0];
    const lockedExampleTerm = exampleTerm ? lockedTermsById.get(exampleTerm.id) : undefined;

    if (!lockedExampleTerm) {
      return [];
    }

    return [{
      id: phonemeId,
      phonemeId,
      label: phoneme?.ipa ?? phonemeId,
      exampleTerm: lockedExampleTerm,
    }];
  });
  const wordCards = groups.flatMap((group) =>
    uniqueTerms(termsByPhoneme.get(group.phonemeId) ?? [])
      .map((term) => lockedTermsById.get(term.id))
      .filter((term): term is MinimalPairTerm => Boolean(term)),
  );

  if (groups.length < 2 || wordCards.length < groups.length) {
    return undefined;
  }

  return {
    id: `sort:${contrastId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    contrastId,
    groups,
    wordCards: shuffleArray(wordCards),
  };
}

function uniqueTerms(terms: MinimalPairTerm[]): MinimalPairTerm[] {
  const seen = new Set<string>();
  const unique: MinimalPairTerm[] = [];

  for (const term of terms) {
    if (seen.has(term.id)) {
      continue;
    }

    seen.add(term.id);
    unique.push(term);
  }

  return unique;
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
