import { getLanguageSlug } from "../languages";
import { contributionPerfectPairDataByLanguage } from "../generated/contribution-perfect-pairs";
import type { AudioSource, LanguageDataset, PhonemeId, WordEntry } from "../languages/types";
import {
  createContributionPerfectPairData,
  type ContributionPerfectPairDataByLanguage,
  type ContributionPerfectPairLanguageData,
} from "./perfect-pair-data";

export const DEFAULT_CONTRIBUTION_TARGET_RECORDINGS = 6;

export interface ContributionQueueItem {
  word: WordEntry;
  shortWordId: string;
  wordRecordingCount: number;
  phonemeCoverage: number;
  priorityPhonemeId: PhonemeId;
  priorityPhonemeRecordingCount: number;
  perfectPairGain: number;
  perfectPairRelativeGain: number;
  perfectPairBaseCount: number;
  perfectPairPhonemeIds: readonly [PhonemeId, PhonemeId] | null;
}

export interface ContributionQueueOptions {
  limit?: number;
  candidateWordIds?: ReadonlySet<string>;
  assumedRecordedWordIds?: readonly string[] | ReadonlySet<string>;
  targetRecordings?: number;
}

interface PerfectPairIndex {
  pairCounts: Map<string, number>;
  opportunitiesByWordId: ContributionPerfectPairLanguageData;
}

const dynamicPerfectPairDataByDataset = new WeakMap<LanguageDataset, ContributionPerfectPairLanguageData>();
const generatedPerfectPairData = contributionPerfectPairDataByLanguage as ContributionPerfectPairDataByLanguage;

export function createContributionQueue(
  sourceDataset: LanguageDataset,
  excludedWordIds: ReadonlySet<string> = new Set(),
  options: ContributionQueueOptions = {},
): ContributionQueueItem[] {
  const targetRecordings = options.targetRecordings ?? DEFAULT_CONTRIBUTION_TARGET_RECORDINGS;
  const phonemeRecordingCounts = createContributionPhonemeRecordingCounts(sourceDataset, targetRecordings);
  const wordsById = new Map(sourceDataset.words.map((word) => [word.id, word]));
  const recordedWordIds = new Set(sourceDataset.words.filter((word) => word.audio.length > 0).map((word) => word.id));
  const perfectPairIndex = createPerfectPairIndex(sourceDataset);
  const indexedRecordedWordIds = new Set<string>();
  const selectedItems: ContributionQueueItem[] = [];
  let candidates = sourceDataset.words.filter((word) =>
    word.audio.length < targetRecordings
    && !excludedWordIds.has(word.id)
    && (!options.candidateWordIds || options.candidateWordIds.has(word.id))
  );

  for (const word of sourceDataset.words) {
    if (recordedWordIds.has(word.id)) {
      addRecordedWordToPerfectPairIndex(word, perfectPairIndex, indexedRecordedWordIds);
      indexedRecordedWordIds.add(word.id);
    }
  }

  for (const wordId of options.assumedRecordedWordIds ?? []) {
    const word = wordsById.get(wordId);

    if (word) {
      if (!recordedWordIds.has(word.id)) {
        addRecordedWordToPerfectPairIndex(word, perfectPairIndex, recordedWordIds);
      }

      recordedWordIds.add(word.id);
      addContributionRecordingCoverage(word, phonemeRecordingCounts, targetRecordings);
    }
  }

  while (candidates.length > 0 && (options.limit === undefined || selectedItems.length < options.limit)) {
    const nextItem = candidates
      .map((word) => createContributionQueueItem(
        word,
        sourceDataset,
        phonemeRecordingCounts,
        recordedWordIds,
        perfectPairIndex,
      ))
      .sort(compareContributionQueueItems)[0];

    if (!nextItem) {
      break;
    }

    selectedItems.push(nextItem);
    if (!recordedWordIds.has(nextItem.word.id)) {
      addRecordedWordToPerfectPairIndex(nextItem.word, perfectPairIndex, recordedWordIds);
    }

    recordedWordIds.add(nextItem.word.id);
    addContributionRecordingCoverage(nextItem.word, phonemeRecordingCounts, targetRecordings);
    candidates = candidates.filter((word) => word.id !== nextItem.word.id);
  }

  return selectedItems;
}

export function contributionWordIdsForSpeaker(
  sourceDataset: LanguageDataset,
  speakerName: string,
): Set<string> {
  const normalizedSpeakerName = normalizeContributionSpeakerName(speakerName);
  const wordIds = new Set<string>();

  if (!normalizedSpeakerName) {
    return wordIds;
  }

  for (const word of sourceDataset.words) {
    if (word.audio.some((source) => contributionSourceMatchesSpeaker(source, normalizedSpeakerName))) {
      wordIds.add(word.id);
    }
  }

  return wordIds;
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
  recordedWordIds: ReadonlySet<string>,
  perfectPairIndex: PerfectPairIndex,
): ContributionQueueItem {
  const priorityPhonemeId = findLowestCoveragePhoneme(word.phonemeIds, phonemeRecordingCounts);
  const priorityPhonemeRecordingCount = phonemeRecordingCounts.get(priorityPhonemeId) ?? 0;
  const perfectPairPriority = createPerfectPairPriority(
    word,
    recordedWordIds,
    perfectPairIndex,
  );

  return {
    word,
    shortWordId: stripWordPrefix(word.id, sourceDataset.id),
    wordRecordingCount: word.audio.length,
    phonemeCoverage: priorityPhonemeRecordingCount,
    priorityPhonemeId,
    priorityPhonemeRecordingCount,
    perfectPairGain: perfectPairPriority.gain,
    perfectPairRelativeGain: perfectPairPriority.relativeGain,
    perfectPairBaseCount: perfectPairPriority.baseCount,
    perfectPairPhonemeIds: perfectPairPriority.phonemeIds,
  };
}

function compareContributionQueueItems(left: ContributionQueueItem, right: ContributionQueueItem): number {
  return comparePerfectPairPriority(left, right)
    || left.phonemeCoverage - right.phonemeCoverage
    || left.wordRecordingCount - right.wordRecordingCount
    || left.word.written.localeCompare(right.word.written)
    || left.word.id.localeCompare(right.word.id);
}

function comparePerfectPairPriority(left: ContributionQueueItem, right: ContributionQueueItem): number {
  const leftAddsPerfectPair = left.perfectPairGain > 0;
  const rightAddsPerfectPair = right.perfectPairGain > 0;

  if (!leftAddsPerfectPair && !rightAddsPerfectPair) {
    return 0;
  }

  if (leftAddsPerfectPair !== rightAddsPerfectPair) {
    return leftAddsPerfectPair ? -1 : 1;
  }

  return right.perfectPairRelativeGain - left.perfectPairRelativeGain
    || left.perfectPairBaseCount - right.perfectPairBaseCount
    || right.perfectPairGain - left.perfectPairGain
    || phonemePairLabel(left.perfectPairPhonemeIds).localeCompare(phonemePairLabel(right.perfectPairPhonemeIds));
}

function createPerfectPairPriority(
  word: WordEntry,
  recordedWordIds: ReadonlySet<string>,
  perfectPairIndex: PerfectPairIndex,
): {
  gain: number;
  relativeGain: number;
  baseCount: number;
  phonemeIds: readonly [PhonemeId, PhonemeId] | null;
} {
  if (recordedWordIds.has(word.id)) {
    return { gain: 0, relativeGain: 0, baseCount: 0, phonemeIds: null };
  }

  let best = { gain: 0, relativeGain: 0, baseCount: 0, phonemeIds: null as readonly [PhonemeId, PhonemeId] | null };

  for (const opportunity of perfectPairIndex.opportunitiesByWordId[word.id] ?? []) {
    const gain = countWordIdsInSet(opportunity[2], recordedWordIds);

    if (gain === 0) {
      continue;
    }

    const baseCount = perfectPairIndex.pairCounts.get(opportunity[0]) ?? 0;
    const relativeGain = gain / Math.max(baseCount, 1);
    const current = { gain, relativeGain, baseCount, phonemeIds: opportunity[1] };

    if (comparePerfectPairScores(current, best) < 0) {
      best = current;
    }
  }

  return best;
}

function comparePerfectPairScores(
  left: { gain: number; relativeGain: number; baseCount: number; phonemeIds: readonly [PhonemeId, PhonemeId] | null },
  right: { gain: number; relativeGain: number; baseCount: number; phonemeIds: readonly [PhonemeId, PhonemeId] | null },
): number {
  const leftAddsPerfectPair = left.gain > 0;
  const rightAddsPerfectPair = right.gain > 0;

  if (!leftAddsPerfectPair && !rightAddsPerfectPair) {
    return 0;
  }

  if (leftAddsPerfectPair !== rightAddsPerfectPair) {
    return leftAddsPerfectPair ? -1 : 1;
  }

  return right.relativeGain - left.relativeGain
    || left.baseCount - right.baseCount
    || right.gain - left.gain
    || phonemePairLabel(left.phonemeIds).localeCompare(phonemePairLabel(right.phonemeIds));
}

function createPerfectPairIndex(sourceDataset: LanguageDataset): PerfectPairIndex {
  const index: PerfectPairIndex = {
    pairCounts: new Map(),
    opportunitiesByWordId: getContributionPerfectPairData(sourceDataset),
  };

  return index;
}

function getContributionPerfectPairData(sourceDataset: LanguageDataset): ContributionPerfectPairLanguageData {
  const generated = generatedPerfectPairData[sourceDataset.id];

  if (generated) {
    return generated;
  }

  const cached = dynamicPerfectPairDataByDataset.get(sourceDataset);

  if (cached) {
    return cached;
  }

  const dynamic = createContributionPerfectPairData(sourceDataset);

  dynamicPerfectPairDataByDataset.set(sourceDataset, dynamic);

  return dynamic;
}

function addRecordedWordToPerfectPairIndex(
  word: WordEntry,
  index: PerfectPairIndex,
  recordedWordIds: ReadonlySet<string>,
): void {
  for (const opportunity of index.opportunitiesByWordId[word.id] ?? []) {
    const addedPairs = countWordIdsInSet(opportunity[2], recordedWordIds);

    index.pairCounts.set(opportunity[0], (index.pairCounts.get(opportunity[0]) ?? 0) + addedPairs);
  }
}

function countWordIdsInSet(wordIds: readonly string[], set: ReadonlySet<string>): number {
  return wordIds.reduce((total, wordId) => total + (set.has(wordId) ? 1 : 0), 0);
}

function phonemePairLabel(phonemeIds: readonly [PhonemeId, PhonemeId] | null): string {
  return phonemeIds ? `${phonemeIds[0]}:${phonemeIds[1]}` : "";
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

function contributionSourceMatchesSpeaker(source: AudioSource, normalizedSpeakerName: string): boolean {
  return source.kind === "contribution"
    && (
      normalizeContributionSpeakerName(source.speaker) === normalizedSpeakerName
      || normalizeContributionSpeakerName(source.attribution) === normalizedSpeakerName
    );
}

function normalizeContributionSpeakerName(speakerName: string | undefined): string {
  return speakerName?.trim().toLowerCase() ?? "";
}
