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
    getResolvedMinimalPairsForPhonemes(dataset, contrast.phonemeIds, contrast.id)
  );
}

export function getResolvedMinimalPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
  contrastId = `custom:${phonemeIds[0]}:${phonemeIds[1]}`,
): MinimalPairItem[] {
  const [firstPhonemeId, secondPhonemeId] = phonemeIds;
  const firstWords = candidateWordsForPhoneme(dataset, firstPhonemeId, secondPhonemeId);
  const secondWords = candidateWordsForPhoneme(dataset, secondPhonemeId, firstPhonemeId);

  return firstWords.flatMap((firstWord) =>
    secondWords.flatMap((secondWord): MinimalPairItem[] => {
      if (firstWord.id === secondWord.id) {
        return [];
      }

      return [{
        id: `${contrastId}:${firstWord.id}:${secondWord.id}`,
        contrastId,
        terms: [
          createWordTerm(firstWord, firstPhonemeId),
          createWordTerm(secondWord, secondPhonemeId),
        ],
        tags: ["generated"],
      }];
    })
  );
}

export function countResolvedMinimalPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
): number {
  const [firstPhonemeId, secondPhonemeId] = phonemeIds;
  const firstWords = candidateWordsForPhoneme(dataset, firstPhonemeId, secondPhonemeId);
  const secondWords = candidateWordsForPhoneme(dataset, secondPhonemeId, firstPhonemeId);

  return firstWords.reduce(
    (total, firstWord) => total + secondWords.filter((secondWord) => secondWord.id !== firstWord.id).length,
    0,
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

function createWordTerm(word: WordEntry, phonemeId: PhonemeId): MinimalPairTerm {
  return {
    id: `${phonemeId}:${word.id}`,
    wordId: word.id,
    phonemeId,
    word,
  };
}
