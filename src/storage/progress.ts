import type { PhonemeId } from "../languages/types";
import type { PromptResult } from "../training/session";

const STORAGE_KEY = "vowel-trowel:progress:v1";
const SCHEMA_VERSION = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AGAIN_INTERVAL_DAYS = 10 / (24 * 60);

export interface AppProgress {
  schemaVersion: 1;
  languages: Record<string, LanguageProgress>;
  updatedAt?: number;
}

export interface LanguageProgress {
  contrastStats: Record<string, ContrastStats>;
  itemStats: Record<string, ItemStats>;
}

export interface ItemStats {
  attempts: number;
  correct: number;
  lastSeenAt?: number;
}

export interface ContrastStats {
  attempts: number;
  correct: number;
  lastSeenAt?: number;
  confusions: Record<string, number>;
  directionStats: Record<string, SpacedRepetitionStats>;
}

export interface SpacedRepetitionStats {
  phonemeId: PhonemeId;
  attempts: number;
  correct: number;
  streak: number;
  ease: number;
  intervalDays: number;
  dueAt: number;
  lastSeenAt?: number;
}

export interface ConfusionSummary {
  key: string;
  contrastId: string;
  heardPhonemeId: PhonemeId;
  chosenPhonemeId: PhonemeId;
  count: number;
}

export function createEmptyProgress(): AppProgress {
  return { schemaVersion: SCHEMA_VERSION, languages: {} };
}

export function loadProgress(): AppProgress {
  if (typeof localStorage === "undefined") {
    return createEmptyProgress();
  }

  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return createEmptyProgress();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppProgress>;

    if (parsed.schemaVersion !== SCHEMA_VERSION || !parsed.languages) {
      return createEmptyProgress();
    }

    return parsed as AppProgress;
  } catch {
    return createEmptyProgress();
  }
}

export function saveProgress(progress: AppProgress): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...progress, updatedAt: Date.now() }));
}

export function resetProgress(): AppProgress {
  const progress = createEmptyProgress();
  saveProgress(progress);
  return progress;
}

export function recordPromptResult(progress: AppProgress, result: PromptResult): AppProgress {
  const next = cloneProgress(progress);
  const language = getOrCreateLanguageProgress(next, result.languageId);
  const contrast = getOrCreateContrastStats(language, result.contrastId);
  const item = getOrCreateItemStats(language, result.itemId);
  const now = result.recordedAt;

  item.attempts += 1;
  item.correct += result.correct ? 1 : 0;
  item.lastSeenAt = now;

  contrast.attempts += result.answers.length;
  contrast.correct += result.answers.filter((answer) => answer.correct).length;
  contrast.lastSeenAt = now;

  for (const answer of result.answers) {
    const directionKey = createDirectionKey(result.contrastId, answer.heardPhonemeId);
    const direction = getOrCreateDirectionStats(contrast, directionKey, answer.heardPhonemeId);

    updateSpacedRepetition(direction, answer.correct, now);
  }

  for (const [confusionKey, count] of promptConfusionCounts(result)) {
    contrast.confusions[confusionKey] = (contrast.confusions[confusionKey] ?? 0) + count;
  }

  next.updatedAt = now;
  return next;
}

export function getTopConfusions(
  progress: AppProgress,
  languageId: string,
  limit = 5,
): ConfusionSummary[] {
  const language = progress.languages[languageId];

  if (!language) {
    return [];
  }

  const summaries = new Map<string, {
    summary: ConfusionSummary;
    directionCounts: Map<string, number>;
  }>();

  for (const [contrastId, contrast] of Object.entries(language.contrastStats)) {
    for (const [key, count] of Object.entries(contrast.confusions)) {
      const [heardPhonemeId, chosenPhonemeId] = key.split("->");

      if (!heardPhonemeId || !chosenPhonemeId) {
        continue;
      }

      const [firstPhonemeId, secondPhonemeId] = orderPhonemePair(heardPhonemeId, chosenPhonemeId);
      const pairKey = createConfusionKey(firstPhonemeId, secondPhonemeId);
      const summaryKey = `${contrastId}:${pairKey}`;
      const existing = summaries.get(summaryKey);

      if (existing) {
        existing.directionCounts.set(key, (existing.directionCounts.get(key) ?? 0) + count);
        existing.summary.count = countConfusionPairMisses(existing.directionCounts);
      } else {
        summaries.set(summaryKey, {
          summary: {
            key: pairKey,
            contrastId,
            heardPhonemeId: firstPhonemeId,
            chosenPhonemeId: secondPhonemeId,
            count,
          },
          directionCounts: new Map([[key, count]]),
        });
      }
    }
  }

  return [...summaries.values()].map(({ summary }) => summary)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function getLanguageProgress(
  progress: AppProgress,
  languageId: string,
): LanguageProgress | undefined {
  return progress.languages[languageId];
}

export function createDirectionKey(contrastId: string, phonemeId: PhonemeId): string {
  return `${contrastId}:${phonemeId}`;
}

function createConfusionKey(heardPhonemeId: PhonemeId, chosenPhonemeId: PhonemeId): string {
  return `${heardPhonemeId}->${chosenPhonemeId}`;
}

function promptConfusionCounts(result: PromptResult): Map<string, number> {
  const incorrectAnswers = result.answers.filter((answer) => !answer.correct);

  if (isTwoChoiceSwap(incorrectAnswers)) {
    const answer = incorrectAnswers[0];

    if (!answer) {
      return new Map();
    }

    const [firstPhonemeId, secondPhonemeId] = orderPhonemePair(answer.heardPhonemeId, answer.chosenPhonemeId);

    return new Map([[createConfusionKey(firstPhonemeId, secondPhonemeId), 1]]);
  }

  const counts = new Map<string, number>();

  for (const answer of incorrectAnswers) {
    const confusionKey = createConfusionKey(answer.heardPhonemeId, answer.chosenPhonemeId);

    counts.set(confusionKey, (counts.get(confusionKey) ?? 0) + 1);
  }

  return counts;
}

function isTwoChoiceSwap(answers: PromptResult["answers"]): boolean {
  const first = answers[0];
  const second = answers[1];

  if (answers.length !== 2 || !first || !second) {
    return false;
  }

  return first.heardPhonemeId === second.chosenPhonemeId
    && first.chosenPhonemeId === second.heardPhonemeId
    && first.heardPhonemeId !== first.chosenPhonemeId;
}

function countConfusionPairMisses(directionCounts: Map<string, number>): number {
  const counts = [...directionCounts.values()];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const reciprocalDuplicateCount = counts.length > 1 ? Math.min(...counts) : 0;

  return total - reciprocalDuplicateCount;
}

function orderPhonemePair(
  leftPhonemeId: PhonemeId,
  rightPhonemeId: PhonemeId,
): readonly [PhonemeId, PhonemeId] {
  return leftPhonemeId.localeCompare(rightPhonemeId) <= 0
    ? [leftPhonemeId, rightPhonemeId]
    : [rightPhonemeId, leftPhonemeId];
}

function updateSpacedRepetition(
  stats: SpacedRepetitionStats,
  correct: boolean,
  now: number,
): void {
  stats.attempts += 1;
  stats.correct += correct ? 1 : 0;
  stats.lastSeenAt = now;

  if (!correct) {
    stats.streak = 0;
    stats.ease = Math.max(1.3, stats.ease - 0.2);
    stats.intervalDays = AGAIN_INTERVAL_DAYS;
    stats.dueAt = now + stats.intervalDays * MS_PER_DAY;
    return;
  }

  stats.streak += 1;
  stats.ease = Math.min(3, stats.ease + 0.05);

  if (stats.streak === 1) {
    stats.intervalDays = 1;
  } else if (stats.streak === 2) {
    stats.intervalDays = 3;
  } else {
    stats.intervalDays = Math.max(1, Math.round(stats.intervalDays * stats.ease));
  }

  stats.dueAt = now + stats.intervalDays * MS_PER_DAY;
}

function getOrCreateLanguageProgress(progress: AppProgress, languageId: string): LanguageProgress {
  progress.languages[languageId] ??= { contrastStats: {}, itemStats: {} };
  return progress.languages[languageId];
}

function getOrCreateContrastStats(
  language: LanguageProgress,
  contrastId: string,
): ContrastStats {
  language.contrastStats[contrastId] ??= {
    attempts: 0,
    correct: 0,
    confusions: {},
    directionStats: {},
  };

  return language.contrastStats[contrastId];
}

function getOrCreateItemStats(language: LanguageProgress, itemId: string): ItemStats {
  language.itemStats[itemId] ??= { attempts: 0, correct: 0 };
  return language.itemStats[itemId];
}

function getOrCreateDirectionStats(
  contrast: ContrastStats,
  key: string,
  phonemeId: PhonemeId,
): SpacedRepetitionStats {
  contrast.directionStats[key] ??= {
    phonemeId,
    attempts: 0,
    correct: 0,
    streak: 0,
    ease: 2.3,
    intervalDays: 0,
    dueAt: 0,
  };

  return contrast.directionStats[key];
}

function cloneProgress(progress: AppProgress): AppProgress {
  return JSON.parse(JSON.stringify(progress)) as AppProgress;
}
