import { getLanguageSlug } from "../languages";
import type { LanguageDataset, PhonemeId, WordEntry } from "../languages/types";

export const DEFAULT_CONTRIBUTION_TARGET_RECORDINGS = 6;

export interface ContributionQueueItem {
  word: WordEntry;
  shortWordId: string;
  wordRecordingCount: number;
  phonemeCoverage: number;
  priorityPhonemeId: PhonemeId;
  priorityPhonemeRecordingCount: number;
}

export interface ContributionQueueOptions {
  limit?: number;
  candidateWordIds?: ReadonlySet<string>;
  assumedRecordedWordIds?: readonly string[] | ReadonlySet<string>;
  targetRecordings?: number;
}

export function createContributionQueue(
  sourceDataset: LanguageDataset,
  excludedWordIds: ReadonlySet<string> = new Set(),
  options: ContributionQueueOptions = {},
): ContributionQueueItem[] {
  const targetRecordings = options.targetRecordings ?? DEFAULT_CONTRIBUTION_TARGET_RECORDINGS;
  const phonemeRecordingCounts = createContributionPhonemeRecordingCounts(sourceDataset, targetRecordings);
  const wordsById = new Map(sourceDataset.words.map((word) => [word.id, word]));
  const selectedItems: ContributionQueueItem[] = [];
  let candidates = sourceDataset.words.filter((word) =>
    word.audio.length < targetRecordings
    && !excludedWordIds.has(word.id)
    && (!options.candidateWordIds || options.candidateWordIds.has(word.id))
  );

  for (const wordId of options.assumedRecordedWordIds ?? []) {
    const word = wordsById.get(wordId);

    if (word) {
      addContributionRecordingCoverage(word, phonemeRecordingCounts, targetRecordings);
    }
  }

  while (candidates.length > 0 && (options.limit === undefined || selectedItems.length < options.limit)) {
    const nextItem = candidates
      .map((word) => createContributionQueueItem(word, sourceDataset, phonemeRecordingCounts))
      .sort(compareContributionQueueItems)[0];

    if (!nextItem) {
      break;
    }

    selectedItems.push(nextItem);
    addContributionRecordingCoverage(nextItem.word, phonemeRecordingCounts, targetRecordings);
    candidates = candidates.filter((word) => word.id !== nextItem.word.id);
  }

  return selectedItems;
}

function createContributionPhonemeRecordingCounts(
  sourceDataset: LanguageDataset,
  targetRecordings: number,
): Map<PhonemeId, number> {
  const phonemeRecordingCounts = new Map<PhonemeId, number>();

  for (const phoneme of sourceDataset.phonemes) {
    phonemeRecordingCounts.set(phoneme.id, 0);
  }

  for (const word of sourceDataset.words) {
    const cappedWordRecordingCount = Math.min(word.audio.length, targetRecordings);

    for (const phonemeId of word.phonemeIds) {
      phonemeRecordingCounts.set(
        phonemeId,
        (phonemeRecordingCounts.get(phonemeId) ?? 0) + cappedWordRecordingCount,
      );
    }
  }

  return phonemeRecordingCounts;
}

function createContributionQueueItem(
  word: WordEntry,
  sourceDataset: LanguageDataset,
  phonemeRecordingCounts: ReadonlyMap<PhonemeId, number>,
): ContributionQueueItem {
  const priorityPhonemeId = findLowestCoveragePhoneme(word.phonemeIds, phonemeRecordingCounts);
  const priorityPhonemeRecordingCount = phonemeRecordingCounts.get(priorityPhonemeId) ?? 0;

  return {
    word,
    shortWordId: stripWordPrefix(word.id, sourceDataset.id),
    wordRecordingCount: word.audio.length,
    phonemeCoverage: priorityPhonemeRecordingCount,
    priorityPhonemeId,
    priorityPhonemeRecordingCount,
  };
}

function compareContributionQueueItems(left: ContributionQueueItem, right: ContributionQueueItem): number {
  return left.phonemeCoverage - right.phonemeCoverage
    || left.wordRecordingCount - right.wordRecordingCount
    || left.word.written.localeCompare(right.word.written)
    || left.word.id.localeCompare(right.word.id);
}

function addContributionRecordingCoverage(
  word: WordEntry,
  phonemeRecordingCounts: Map<PhonemeId, number>,
  targetRecordings: number,
): void {
  if (word.audio.length >= targetRecordings) {
    return;
  }

  for (const phonemeId of word.phonemeIds) {
    phonemeRecordingCounts.set(phonemeId, (phonemeRecordingCounts.get(phonemeId) ?? 0) + 1);
  }
}

function findLowestCoveragePhoneme(
  phonemeIds: readonly PhonemeId[],
  phonemeRecordingCounts: ReadonlyMap<PhonemeId, number>,
): PhonemeId {
  const firstPhonemeId = phonemeIds[0];

  if (!firstPhonemeId) {
    return "";
  }

  return phonemeIds.reduce((lowest, phonemeId) =>
    (phonemeRecordingCounts.get(phonemeId) ?? 0) < (phonemeRecordingCounts.get(lowest) ?? 0)
      ? phonemeId
      : lowest
  , firstPhonemeId);
}

function stripWordPrefix(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId.slice(prefix.length) : wordId;
}
