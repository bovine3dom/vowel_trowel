import { spawnSync } from "node:child_process";

import { createContributionQueue } from "../src/contributions/queue";
import { getLanguageDataset } from "../src/languages";
import type { LanguageDataset, WordEntry } from "../src/languages/types";

type DownloadMode = "none" | "regional" | "all";
type AudioCandidateSource = "wiktionary" | "mswc";

interface CliOptions {
  languageId: string;
  source: AudioCandidateSource;
  words: string[];
  limit: number | null;
  coverageTarget: number;
  download: DownloadMode;
  maxCandidatesPerWord: number;
  reviewLimit: number | null;
  review: boolean;
  apply: boolean;
  play: boolean;
  includeReviewed: boolean;
  includeIpaMismatches: boolean;
  progress: boolean;
  email: string | null;
  includeMergedFrance: boolean;
  targetPhonemes: string[];
  mswcRoot: string | null;
  cvValidated: string | null;
  dryRun: boolean;
}

interface WordCoverageInfo {
  word: WordEntry;
  phonemeIds: readonly string[];
  key: string;
}

interface CoverageGroup {
  key: string;
  phonemeIds: readonly string[];
  words: WordCoverageInfo[];
  approvedRecordings: number;
  deficit: number;
}

const options = parseArgs(process.argv.slice(2));
const dataset = getLanguageDataset(options.languageId);
const coveragePlan = createCoveragePlan(dataset, options);
const selectedWords = coveragePlan.selectedWords;

if (selectedWords.length === 0) {
  console.log(coveragePlan.message);
  process.exit(0);
}

console.log(`Language: ${dataset.name}`);
console.log(`Source: ${options.source}`);
console.log(`Coverage target: ${options.coverageTarget} approved recording${options.coverageTarget === 1 ? "" : "s"} per target phoneme set.`);
console.log(`Under-covered sets: ${formatCoverageGroups(coveragePlan.underCoveredGroups, options.coverageTarget)}`);
console.log(`Words: ${selectedWords.map((word) => word.written).join(", ")}`);

if (coveragePlan.candidateWords.length > selectedWords.length) {
  console.log(`Showing ${selectedWords.length} of ${coveragePlan.candidateWords.length}. Pass --all or raise --limit to review more.`);
}

if (options.dryRun) {
  process.exit(0);
}

const wordsArg = selectedWords.map((word) => word.written).join(",");

if (options.download !== "none") {
  const discovery = getDiscoveryStep(options, dataset.id, wordsArg);

  runStep(1, 3, discovery.label, discovery.scriptPath, discovery.args);
}

if (options.review) {
  runStep(2, 3, "Reviewing downloaded candidates", "scripts/review-audio-candidates.ts", compactArgs([
    `--source=${options.source}`,
    `--language=${dataset.id}`,
    `--words=${wordsArg}`,
    options.reviewLimit === null ? null : `--limit=${options.reviewLimit}`,
    options.includeReviewed ? "--include-reviewed" : null,
    options.play ? null : "--no-play",
  ]));
}

if (options.apply) {
  runStep(3, 3, "Applying approved recordings", "scripts/apply-reviewed-audio.ts", [
    `--source=${options.source}`,
    `--language=${dataset.id}`,
  ]);
}

console.log("Audio review workflow finished.");

function runStep(index: number, total: number, label: string, scriptPath: string, args: readonly string[]): void {
  console.log(`\n[${index}/${total}] ${label}`);

  const result = spawnSync(process.execPath, ["run", scriptPath, ...args], { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string[]>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey ?? "";
    const value = rest.length > 0 ? rest.join("=") : "true";
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  if (values.has("help")) {
    printUsage();
    process.exit(0);
  }

  const source = parseSource(getLast(values, "source"));

  return {
    languageId: getLanguageDataset(getLast(values, "language") ?? getLast(values, "lang")).id,
    source,
    words: splitList([...(values.get("word") ?? []), ...(values.get("words") ?? [])]),
    limit: values.has("all") ? null : parseOptionalInteger(getLast(values, "limit")),
    coverageTarget: parseInteger(getLast(values, "coverage-target") ?? "4"),
    download: parseDownloadMode(getLast(values, "download") ?? "all"),
    maxCandidatesPerWord: parseInteger(getLast(values, "max-candidates-per-word") ?? "4"),
    reviewLimit: parseOptionalInteger(getLast(values, "review-limit")),
    review: !values.has("no-review"),
    apply: !values.has("no-apply"),
    play: !values.has("no-play"),
    includeReviewed: values.has("include-reviewed"),
    includeIpaMismatches: values.has("include-ipa-mismatches"),
    progress: !values.has("no-progress"),
    email: getLast(values, "email") ?? null,
    includeMergedFrance: values.has("include-merged-france"),
    targetPhonemes: values.get("target-phoneme") ?? [],
    mswcRoot: getLast(values, "mswc-root") ?? null,
    cvValidated: getLast(values, "cv-validated") ?? null,
    dryRun: values.has("dry-run"),
  };
}

function printUsage(): void {
  console.log("Usage: bun run audio:wizard -- [options]");
  console.log("Default: queue words from target phoneme sets with fewer than 4 approved recordings, Wiktionary source, download up to 4 candidates each, review, then apply approvals.");
  console.log("Options: --source=wiktionary|mswc --language=en-GB --words=ship,sheep --coverage-target=4 --limit=20 --all --download=all|regional|none --max-candidates-per-word=6 --review-limit=20 --target-phoneme=live:en-gb-kit --include-merged-france --include-ipa-mismatches --no-progress --no-play --no-review --no-apply --dry-run");
}

function createCoveragePlan(
  dataset: LanguageDataset,
  opts: CliOptions,
): {
  selectedWords: WordEntry[];
  candidateWords: WordEntry[];
  underCoveredGroups: CoverageGroup[];
  message: string;
} {
  const wordInfoById = createWordCoverageInfo(dataset, parseTargetPhonemeOverrides(opts.targetPhonemes));
  const requestedWords = opts.words.length > 0 ? selectRequestedWords(dataset.words, opts.words) : [];

  if (opts.words.length > 0 && requestedWords.length === 0) {
    return {
      selectedWords: [],
      candidateWords: [],
      underCoveredGroups: [],
      message: "No matching words found. Check spelling or word IDs.",
    };
  }

  const requestedGroupKeys = new Set(
    requestedWords.flatMap((word) => {
      const info = wordInfoById.get(word.id);

      return info ? [info.key] : [];
    }),
  );
  const groups = createCoverageGroups([...wordInfoById.values()], opts.coverageTarget)
    .filter((group) => requestedGroupKeys.size === 0 || requestedGroupKeys.has(group.key));
  const underCoveredGroups = groups.filter((group) => group.deficit > 0);
  const candidateWords = selectCoverageWords(underCoveredGroups, requestedWords, dataset, opts.coverageTarget);
  const selectedWords = opts.limit === null ? candidateWords : candidateWords.slice(0, opts.limit);

  return {
    selectedWords,
    candidateWords,
    underCoveredGroups,
    message: requestedGroupKeys.size > 0
      ? `Requested target phoneme sets already have at least ${opts.coverageTarget} approved recording${opts.coverageTarget === 1 ? "" : "s"}.`
      : `Every target phoneme set already has at least ${opts.coverageTarget} approved recording${opts.coverageTarget === 1 ? "" : "s"}.`,
  };
}

function createWordCoverageInfo(
  dataset: LanguageDataset,
  targetOverrides: ReadonlyMap<string, readonly string[]>,
): Map<string, WordCoverageInfo> {
  const targetPhonemesByWord = new Map<string, Set<string>>();

  for (const contrast of dataset.contrasts) {
    for (const pair of contrast.minimalPairs) {
      for (const term of pair.terms) {
        const phonemeIds = targetPhonemesByWord.get(term.wordId) ?? new Set<string>();

        phonemeIds.add(term.phonemeId);
        targetPhonemesByWord.set(term.wordId, phonemeIds);
      }
    }
  }

  return new Map(dataset.words.map((word) => {
    const override = getTargetOverride(word, targetOverrides);
    const phonemeIds = override ?? [...(targetPhonemesByWord.get(word.id) ?? word.phonemeIds)];
    const normalizedPhonemeIds = uniqueSorted(phonemeIds);

    return [word.id, {
      word,
      phonemeIds: normalizedPhonemeIds,
      key: createPhonemeSetKey(normalizedPhonemeIds),
    }];
  }));
}

function createCoverageGroups(
  infos: readonly WordCoverageInfo[],
  coverageTarget: number,
): CoverageGroup[] {
  const byKey = new Map<string, WordCoverageInfo[]>();

  for (const info of infos) {
    byKey.set(info.key, [...(byKey.get(info.key) ?? []), info]);
  }

  return [...byKey.entries()]
    .map(([key, words]) => {
      const approvedRecordings = words.reduce((total, info) => total + info.word.audio.length, 0);

      return {
        key,
        phonemeIds: words[0]?.phonemeIds ?? [],
        words,
        approvedRecordings,
        deficit: Math.max(0, coverageTarget - approvedRecordings),
      };
    })
    .sort((left, right) => {
      const deficitDifference = right.deficit - left.deficit;

      return deficitDifference !== 0 ? deficitDifference : left.key.localeCompare(right.key);
    });
}

function selectCoverageWords(
  groups: readonly CoverageGroup[],
  requestedWords: readonly WordEntry[],
  dataset: LanguageDataset,
  coverageTarget: number,
): WordEntry[] {
  const selectionLimit = groups.reduce((total, group) => total + group.deficit, 0);
  const candidateWordIds = new Set(groups.flatMap((group) => group.words.map((info) => info.word.id)));
  const requestedCandidateWordIds = new Set(
    requestedWords
      .filter((word) => candidateWordIds.has(word.id))
      .map((word) => word.id),
  );
  const requestedQueue = requestedCandidateWordIds.size > 0
    ? createContributionQueue(dataset, new Set(), {
      candidateWordIds: requestedCandidateWordIds,
      limit: Math.min(selectionLimit, requestedCandidateWordIds.size),
      targetRecordings: coverageTarget,
    })
    : [];
  const requestedQueueWordIds = new Set(requestedQueue.map((item) => item.word.id));
  const remainingLimit = Math.max(0, selectionLimit - requestedQueue.length);
  const fillQueue = remainingLimit > 0
    ? createContributionQueue(dataset, requestedQueueWordIds, {
      assumedRecordedWordIds: requestedQueueWordIds,
      candidateWordIds,
      limit: remainingLimit,
      targetRecordings: coverageTarget,
    })
    : [];

  return [...requestedQueue, ...fillQueue].map((item) => item.word);
}

function formatCoverageGroups(groups: readonly CoverageGroup[], coverageTarget: number): string {
  if (groups.length === 0) {
    return "none";
  }

  const visible = groups.slice(0, 10).map((group) =>
    `${formatPhonemeSet(group.phonemeIds)} ${group.approvedRecordings}/${coverageTarget}`
  );

  return groups.length > visible.length
    ? `${visible.join("; ")}; +${groups.length - visible.length} more`
    : visible.join("; ");
}

function formatPhonemeSet(phonemeIds: readonly string[]): string {
  return phonemeIds.length > 0 ? phonemeIds.join("+") : "unknown";
}

function getDiscoveryStep(
  opts: CliOptions,
  languageId: string,
  wordsArg: string,
): { label: string; scriptPath: string; args: string[] } {
  if (opts.source === "mswc") {
    return {
      label: "Finding and staging MSWC/Common Voice candidate recordings",
      scriptPath: "scripts/mswc-audio-report.ts",
      args: compactArgs([
        `--language=${languageId}`,
        `--words=${wordsArg}`,
        `--download=${opts.download}`,
        `--max-candidates-per-word=${opts.maxCandidatesPerWord}`,
        opts.includeMergedFrance ? "--include-merged-france" : null,
        opts.mswcRoot ? `--mswc-root=${opts.mswcRoot}` : null,
        opts.cvValidated ? `--cv-validated=${opts.cvValidated}` : null,
        ...opts.targetPhonemes.map((target) => `--target-phoneme=${target}`),
      ]),
    };
  }

  return {
    label: "Finding and downloading Wiktionary/Commons candidate recordings",
    scriptPath: "scripts/wiktionary-audio-report.ts",
    args: compactArgs([
      `--language=${languageId}`,
      `--words=${wordsArg}`,
      `--download=${opts.download}`,
      `--max-candidates-per-word=${opts.maxCandidatesPerWord}`,
      opts.includeIpaMismatches ? "--include-ipa-mismatches" : null,
      opts.progress ? null : "--no-progress",
      opts.email ? `--email=${opts.email}` : null,
    ]),
  };
}

function selectRequestedWords(words: readonly WordEntry[], requests: readonly string[]): WordEntry[] {
  const exactRequests = new Set(requests.map(normalizeExactText));
  const exactMatches = words.filter((word) =>
    exactRequests.has(normalizeExactText(word.written)) || exactRequests.has(normalizeExactText(word.id))
  );
  const exactMatchIds = new Set(exactMatches.map((word) => word.id));
  const unresolvedRequests = requests.filter((request) =>
    !words.some((word) =>
      normalizeExactText(word.written) === normalizeExactText(request)
      || normalizeExactText(word.id) === normalizeExactText(request)
    )
  );
  const fallbackRequests = new Set(unresolvedRequests.map(normalizeSearchText));
  const fallbackMatches = words.filter((word) =>
    !exactMatchIds.has(word.id)
    && (fallbackRequests.has(normalizeSearchText(word.written)) || fallbackRequests.has(normalizeSearchText(word.id)))
  );

  return [...exactMatches, ...fallbackMatches];
}

function parseTargetPhonemeOverrides(values: readonly string[]): Map<string, string[]> {
  const overrides = new Map<string, string[]>();

  for (const value of values) {
    const separatorIndex = value.indexOf(":");

    if (separatorIndex < 0) {
      throw new Error(`Expected --target-phoneme=word:phoneme[,phoneme], got ${value}.`);
    }

    const wordKey = value.slice(0, separatorIndex).trim();
    const phonemeIds = splitList([value.slice(separatorIndex + 1)]);

    if (!wordKey || phonemeIds.length === 0) {
      throw new Error(`Expected --target-phoneme=word:phoneme[,phoneme], got ${value}.`);
    }

    overrides.set(normalizeExactText(wordKey), phonemeIds);
  }

  return overrides;
}

function getTargetOverride(
  word: WordEntry,
  overrides: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  return cloneOverride(overrides.get(normalizeExactText(word.id)))
    ?? cloneOverride(overrides.get(normalizeExactText(word.written)))
    ?? cloneOverride(overrides.get(normalizeSearchText(word.written)));
}

function cloneOverride(value: readonly string[] | undefined): string[] | null {
  return value ? [...value] : null;
}

function createPhonemeSetKey(phonemeIds: readonly string[]): string {
  return phonemeIds.map(encodeURIComponent).join("+") || "unknown";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function getLast(values: Map<string, string[]>, key: string): string | undefined {
  const entries = values.get(key);

  return entries ? entries[entries.length - 1] : undefined;
}

function splitList(values: readonly string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | null {
  return value ? parseInteger(value) : null;
}

function parseDownloadMode(value: string): DownloadMode {
  if (value === "none" || value === "regional" || value === "all") {
    return value;
  }

  throw new Error(`Expected --download=none, --download=regional, or --download=all; got ${value}.`);
}

function parseSource(value: string | undefined): AudioCandidateSource {
  if (!value || value === "wiktionary") {
    return "wiktionary";
  }

  if (value === "mswc") {
    return "mswc";
  }

  throw new Error(`Expected --source=wiktionary or --source=mswc; got ${value}.`);
}

function normalizeExactText(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSearchText(value: string): string {
  return normalizeExactText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function compactArgs(args: readonly (string | null)[]): string[] {
  return args.filter((arg): arg is string => Boolean(arg));
}
