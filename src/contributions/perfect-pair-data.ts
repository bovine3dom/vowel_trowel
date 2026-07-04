import { getWordPhonemeShell } from "../languages/resolve";
import type { LanguageDataset, PhonemeId, WordEntry } from "../languages/types";

export type ContributionPerfectPairOpportunity = readonly [
  pairKey: string,
  phonemeIds: readonly [PhonemeId, PhonemeId],
  counterpartWordIds: readonly string[],
];

export type ContributionPerfectPairLanguageData = Readonly<Record<string, readonly ContributionPerfectPairOpportunity[]>>;

export type ContributionPerfectPairDataByLanguage = Readonly<Record<string, ContributionPerfectPairLanguageData>>;

export function createContributionPerfectPairData(sourceDataset: LanguageDataset): ContributionPerfectPairLanguageData {
  const result: Record<string, ContributionPerfectPairOpportunity[]> = {};

  for (const word of sourceDataset.words) {
    const opportunities = createWordPerfectPairOpportunities(word, sourceDataset);

    if (opportunities.length > 0) {
      result[word.id] = opportunities;
    }
  }

  return result;
}

function createWordPerfectPairOpportunities(
  word: WordEntry,
  sourceDataset: LanguageDataset,
): ContributionPerfectPairOpportunity[] {
  const opportunities: ContributionPerfectPairOpportunity[] = [];

  for (const phonemeId of uniquePhonemeIds(word.phonemeIds)) {
    for (const otherPhoneme of sourceDataset.phonemes) {
      const otherPhonemeId = otherPhoneme.id;

      if (!canWordRepresentContrastPhoneme(word, phonemeId, otherPhonemeId)) {
        continue;
      }

      const shell = getWordPhonemeShell(sourceDataset, word, phonemeId);

      if (!shell) {
        continue;
      }

      const counterpartWordIds = sourceDataset.words
        .filter((candidate) =>
          canWordRepresentContrastPhoneme(candidate, otherPhonemeId, phonemeId)
          && getWordPhonemeShell(sourceDataset, candidate, otherPhonemeId) === shell
        )
        .map((candidate) => candidate.id);

      if (counterpartWordIds.length === 0) {
        continue;
      }

      const phonemeIds = orderPhonemePair(sourceDataset, phonemeId, otherPhonemeId);

      opportunities.push([
        phonemePairKey(phonemeIds),
        phonemeIds,
        counterpartWordIds,
      ]);
    }
  }

  return opportunities;
}

function canWordRepresentContrastPhoneme(
  word: WordEntry,
  phonemeId: PhonemeId,
  excludedPhonemeId: PhonemeId,
): boolean {
  return phonemeId !== excludedPhonemeId
    && word.phonemeIds.includes(phonemeId)
    && !word.phonemeIds.includes(excludedPhonemeId);
}

function uniquePhonemeIds(phonemeIds: readonly PhonemeId[]): PhonemeId[] {
  return [...new Set(phonemeIds)];
}

function orderPhonemePair(
  sourceDataset: LanguageDataset,
  firstPhonemeId: PhonemeId,
  secondPhonemeId: PhonemeId,
): readonly [PhonemeId, PhonemeId] {
  return comparePhonemeOrder(sourceDataset, firstPhonemeId, secondPhonemeId) <= 0
    ? [firstPhonemeId, secondPhonemeId]
    : [secondPhonemeId, firstPhonemeId];
}

function comparePhonemeOrder(
  sourceDataset: LanguageDataset,
  firstPhonemeId: PhonemeId,
  secondPhonemeId: PhonemeId,
): number {
  const firstIndex = sourceDataset.phonemes.findIndex((phoneme) => phoneme.id === firstPhonemeId);
  const secondIndex = sourceDataset.phonemes.findIndex((phoneme) => phoneme.id === secondPhonemeId);

  if (firstIndex >= 0 && secondIndex >= 0) {
    return firstIndex - secondIndex;
  }

  if (firstIndex >= 0) {
    return -1;
  }

  if (secondIndex >= 0) {
    return 1;
  }

  return firstPhonemeId.localeCompare(secondPhonemeId);
}

function phonemePairKey(phonemeIds: readonly [PhonemeId, PhonemeId]): string {
  return `${phonemeIds[0]}\u0000${phonemeIds[1]}`;
}
