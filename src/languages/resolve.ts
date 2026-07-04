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

export function countPerfectMinimalPairsForPhonemes(
  dataset: LanguageDataset,
  phonemeIds: readonly [PhonemeId, PhonemeId],
): number {
  return getResolvedMinimalPairsForPhonemes(dataset, phonemeIds)
    .filter((item) => {
      const firstTerm = item.terms[0];
      const secondTerm = item.terms[1];

      return scoreWordPairDistanceForPhonemes(
        dataset,
        firstTerm.word,
        firstTerm.phonemeId,
        secondTerm.word,
        secondTerm.phonemeId,
      ) === 0;
    })
    .length;
}

export function scoreWordPairDistanceForPhonemes(
  dataset: LanguageDataset,
  firstWord: WordEntry,
  firstPhonemeId: PhonemeId,
  secondWord: WordEntry,
  secondPhonemeId: PhonemeId,
): number {
  const firstShell = getWordPhonemeShell(dataset, firstWord, firstPhonemeId);
  const secondShell = getWordPhonemeShell(dataset, secondWord, secondPhonemeId);

  return firstShell && secondShell
    ? levenshteinDistance(firstShell, secondShell)
    : Number.POSITIVE_INFINITY;
}

export function getWordPhonemeShell(
  dataset: LanguageDataset,
  word: WordEntry,
  phonemeId: PhonemeId,
): string | null {
  const targetIpa = phonemeIpa(dataset, phonemeId);

  return targetIpa ? ipaShell(word.ipa, targetIpa) : null;
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

function phonemeIpa(dataset: LanguageDataset, phonemeId: PhonemeId): string | undefined {
  return dataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.ipa;
}

function ipaShell(wordIpa: string, targetPhonemeIpa: string): string {
  const word = normalizeIpaText(wordIpa);
  const target = normalizeIpaText(targetPhonemeIpa);

  return target ? word.replace(target, "_") : word;
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
