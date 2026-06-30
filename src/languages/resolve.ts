import type {
  LanguageDataset,
  MinimalPairItem,
  MinimalPairTerm,
  PhonemeContrast,
  PhonemeId,
  WordEntry,
} from "./types";

export function getResolvedMinimalPairs(dataset: LanguageDataset): MinimalPairItem[] {
  return dataset.contrasts.flatMap((contrast) =>
    contrast.minimalPairs.map((pair) => ({
      id: pair.id,
      contrastId: contrast.id,
      terms: [
        resolveMinimalPairTerm(dataset, contrast, pair.id, pair.terms[0]),
        resolveMinimalPairTerm(dataset, contrast, pair.id, pair.terms[1]),
      ],
      tags: pair.tags,
      notes: pair.notes,
    })),
  );
}

export function getWordsForContrastPhoneme(
  dataset: LanguageDataset,
  contrast: PhonemeContrast,
  phonemeId: PhonemeId,
): MinimalPairTerm[] {
  return dataset.words
    .filter((word) => {
      const matchingContrastPhonemes = contrast.phonemeIds.filter((candidate) =>
        word.phonemeIds.includes(candidate),
      );

      return matchingContrastPhonemes.length === 1 && matchingContrastPhonemes[0] === phonemeId;
    })
    .map((word) => createWordTerm(word, phonemeId));
}

export function findWord(dataset: LanguageDataset, wordId: string): WordEntry | undefined {
  return dataset.words.find((word) => word.id === wordId);
}

function resolveMinimalPairTerm(
  dataset: LanguageDataset,
  contrast: PhonemeContrast,
  pairId: string,
  term: { id?: string; wordId: string; phonemeId: PhonemeId },
): MinimalPairTerm {
  const word = findWord(dataset, term.wordId);

  if (!word) {
    throw new Error(`Minimal pair ${pairId} in ${contrast.id} references missing word ${term.wordId}.`);
  }

  return {
    id: term.id ?? term.wordId,
    wordId: term.wordId,
    phonemeId: term.phonemeId,
    word,
  };
}

function createWordTerm(word: WordEntry, phonemeId: PhonemeId): MinimalPairTerm {
  return {
    id: `${phonemeId}:${word.id}`,
    wordId: word.id,
    phonemeId,
    word,
  };
}
