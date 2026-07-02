import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { getLanguageDataset, getLanguageSlug, sameLanguageId } from "../src/languages";
import type { AudioSource, LanguageDataset, Phoneme, PhonemeId, WordEntry } from "../src/languages/types";
import {
  createCandidateKey,
  getStoredReview,
  loadReviewState,
  type AudioReviewState,
  type CandidateReview,
} from "./audio-review-state";

type DownloadMode = "none" | "regional" | "all";

interface CliOptions {
  languageId: string;
  words: string[];
  limit: number | null;
  output: string;
  markdown: string | null;
  mswcRoot: string;
  cvValidated: string | null;
  maxCandidatesPerWord: number;
  download: DownloadMode;
  downloadDir: string;
  reviewStatePath: string;
  forceDownloadReviewed: boolean;
  includeMergedFrance: boolean;
  targetPhonemeOverrides: Map<string, string[]>;
}

interface MswcRow {
  link: string;
  word: string;
  clipPath: string;
  clipStem: string;
}

interface CommonVoiceMetadata {
  path: string;
  locale?: string;
  accents?: string;
  variant?: string;
  upVotes?: number;
  downVotes?: number;
}

interface WordTargetInfo {
  targetPhonemeIds: string[];
  targetPhonemes: Array<Pick<Phoneme, "id" | "ipa" | "label">>;
  targetContrasts: string[];
  override: boolean;
}

interface AccentPolicy {
  status: "preferred" | "neutral" | "excluded";
  notes: string[];
}

interface GraphemeCheck {
  status: "needs-review" | "target-selected";
  notes: string[];
}

interface MswcCandidate {
  key: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  fileTitle: string;
  audioUrl: null;
  license: string;
  licenseShortName: string;
  attribution: string;
  regions: string[];
  targetPhonemeIds: string[];
  targetPhonemes: WordTargetInfo["targetPhonemes"];
  targetContrasts: string[];
  graphemeCheck: GraphemeCheck;
  accentPolicy: AccentPolicy;
  commonVoice?: CommonVoiceMetadata;
  mswc: {
    languageCode: string;
    link: string;
    word: string;
  };
  score: number;
  reasons: string[];
  suggestedAudioSource: AudioSource;
  review: CandidateReview;
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
}

interface WordAudioReport {
  wordId: string;
  written: string;
  ipa: string;
  phonemeIds: readonly string[];
  targetPhonemeIds: string[];
  targetContrasts: string[];
  candidates: MswcCandidate[];
}

interface AudioReport {
  generatedAt: string;
  source: "mswc";
  language: {
    id: string;
    name: string;
    mswcCode: string;
  };
  paths: {
    mswcRoot: string;
    cvValidated: string | null;
  };
  summary: {
    totalWords: number;
    wordsWithCandidates: number;
    preferredAccentCandidates: number;
    excludedMergedFranceCandidates: number;
    totalCandidates: number;
    stagedCandidates: number;
  };
  words: WordAudioReport[];
}

const MSWC_SOURCE_NAME = "MSWC/Common Voice";
const MSWC_SOURCE_URL = "https://mlcommons.org/en/multilingual-spoken-words";
const COMMON_VOICE_LICENSE = "CC0-1.0";
const COMMON_VOICE_ATTRIBUTION = "Mozilla Common Voice via MLCommons Multilingual Spoken Words Corpus";
const FRENCH_MERGER_SENSITIVE_CONTRASTS = new Set(["fr-un-in"]);
const AUDIO_EXTENSIONS = new Set(["oga", "ogg", "opus", "mp3", "wav", "webm", "flac", "m4a"]);

const options = parseArgs(process.argv.slice(2));
const dataset = getLanguageDataset(options.languageId);
const mswcCode = getMswcLanguageCode(options.languageId);
const targetWords = selectWords(dataset.words, options);
const targetInfoByWord = createWordTargetInfo(dataset, options.targetPhonemeOverrides);
const reviewState = await loadReviewState(options.reviewStatePath);
const report = await buildReport(dataset, targetWords, targetInfoByWord, mswcCode, options, reviewState);

await writeJson(options.output, report);

if (options.markdown) {
  await writeText(options.markdown, renderMarkdown(report));
}

printSummary(report, options);

async function buildReport(
  dataset: LanguageDataset,
  words: readonly WordEntry[],
  targetInfoByWord: ReadonlyMap<string, WordTargetInfo>,
  mswcCode: string,
  opts: CliOptions,
  reviewState: AudioReviewState,
): Promise<AudioReport> {
  const rowsByWord = await readMswcClipDirectories(opts.mswcRoot, mswcCode, words);
  const cvMetadataByStem = opts.cvValidated
    ? await readCommonVoiceMetadata(opts.cvValidated, rowsByWord)
    : new Map<string, CommonVoiceMetadata>();
  const wordReports: WordAudioReport[] = [];
  let stagedCandidates = 0;
  let excludedMergedFranceCandidates = 0;

  for (const word of words) {
    const targetInfo = targetInfoByWord.get(word.id) ?? createFallbackTargetInfo(word, dataset);
    const rows = rowsByWord.get(word.id) ?? [];
    const candidates = rows
      .flatMap((row) => {
        const candidate = createCandidate(dataset, word, targetInfo, row, cvMetadataByStem.get(row.clipStem), mswcCode);

        if (candidate.accentPolicy.status === "excluded") {
          excludedMergedFranceCandidates += 1;
        }

        if (candidate.accentPolicy.status === "excluded" && !opts.includeMergedFrance) {
          return [];
        }

        return [applyStoredReview(word, candidate, reviewState)];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, opts.maxCandidatesPerWord);

    if (opts.download !== "none") {
      for (const candidate of candidates) {
        if (opts.download === "regional" && candidate.regions.length === 0 && candidate.accentPolicy.status !== "preferred") {
          continue;
        }

        if (candidate.review.status !== "pending" && !opts.forceDownloadReviewed) {
          continue;
        }

        const row = rows.find((candidateRow) => candidateRow.link === candidate.mswc.link);

        if (!row || !(await pathExists(row.clipPath))) {
          candidate.reasons.push("local MSWC clip file missing; candidate was not staged");
          continue;
        }

        const paths = await stageCandidate(word, candidate, row, opts);

        candidate.localPath = paths.localPath;
        candidate.metadataPath = paths.metadataPath;
        candidate.datasetSrc = paths.datasetSrc;
        candidate.suggestedAudioSource = {
          ...candidate.suggestedAudioSource,
          src: paths.datasetSrc,
        };
        stagedCandidates += 1;
      }
    }

    wordReports.push({
      wordId: word.id,
      written: word.written,
      ipa: word.ipa,
      phonemeIds: word.phonemeIds,
      targetPhonemeIds: targetInfo.targetPhonemeIds,
      targetContrasts: targetInfo.targetContrasts,
      candidates,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "mswc",
    language: {
      id: dataset.id,
      name: dataset.name,
      mswcCode,
    },
    paths: {
      mswcRoot: opts.mswcRoot,
      cvValidated: opts.cvValidated,
    },
    summary: {
      totalWords: wordReports.length,
      wordsWithCandidates: wordReports.filter((word) => word.candidates.length > 0).length,
      preferredAccentCandidates: wordReports.reduce(
        (total, word) => total + word.candidates.filter((candidate) => candidate.accentPolicy.status === "preferred").length,
        0,
      ),
      excludedMergedFranceCandidates,
      totalCandidates: wordReports.reduce((total, word) => total + word.candidates.length, 0),
      stagedCandidates,
    },
    words: wordReports,
  };
}

async function readMswcClipDirectories(
  mswcRoot: string,
  mswcCode: string,
  words: readonly WordEntry[],
): Promise<Map<string, MswcRow[]>> {
  const clipsRoot = path.join(mswcRoot, mswcCode, "clips");

  if (!(await pathExists(clipsRoot))) {
    throw new Error(`MSWC clips directory not found: ${clipsRoot}. Pass --mswc-root=<path> if your corpus is elsewhere.`);
  }

  const rowsByWord = new Map<string, MswcRow[]>();

  for (const word of words) {
    const directory = await resolveWordClipDirectory(clipsRoot, word);

    if (!directory) {
      continue;
    }

    const filenames = (await readdir(directory.path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && isAudioFilename(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));

    for (const filename of filenames) {
      const link = `${directory.wordDirectory}/${filename}`;
      const clipPath = path.join(directory.path, filename);

      rowsByWord.set(word.id, [...(rowsByWord.get(word.id) ?? []), {
        link,
        word: directory.wordDirectory,
        clipPath,
        clipStem: getStem(filename),
      }]);
    }
  }

  return rowsByWord;
}

async function resolveWordClipDirectory(
  clipsRoot: string,
  word: WordEntry,
): Promise<{ path: string; wordDirectory: string } | null> {
  for (const wordDirectory of getWordDirectoryCandidates(word)) {
    const directoryPath = path.join(clipsRoot, wordDirectory);

    if (await isDirectory(directoryPath)) {
      return { path: directoryPath, wordDirectory };
    }
  }

  return null;
}

function getWordDirectoryCandidates(word: WordEntry): string[] {
  const candidates = new Set<string>();
  const exact = word.written.normalize("NFC").trim();
  const normalizedExact = normalizeExactText(word.written);
  const normalizedSearch = normalizeSearchText(word.written);

  if (exact) {
    candidates.add(exact);
  }

  if (normalizedExact) {
    candidates.add(normalizedExact);
  }

  if (normalizedSearch === normalizedExact) {
    candidates.add(normalizedSearch);
  }

  return [...candidates];
}

async function readCommonVoiceMetadata(
  validatedPath: string,
  rowsByWord: ReadonlyMap<string, readonly MswcRow[]>,
): Promise<Map<string, CommonVoiceMetadata>> {
  if (!(await pathExists(validatedPath))) {
    return new Map();
  }

  const targetStems = new Set<string>();

  for (const rows of rowsByWord.values()) {
    for (const row of rows) {
      targetStems.add(row.clipStem);
    }
  }

  if (targetStems.size === 0) {
    return new Map();
  }

  const metadata = new Map<string, CommonVoiceMetadata>();
  const rl = createInterface({ input: createReadStream(validatedPath), crlfDelay: Number.POSITIVE_INFINITY });
  let headers: string[] | null = null;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    if (!headers) {
      headers = parseDelimitedLine(line, "\t").map((header) => header.trim());
      continue;
    }

    const row = recordFromFields(headers, parseDelimitedLine(line, "\t"));
    const cvPath = row.path;

    if (!cvPath) {
      continue;
    }

    const stem = getStem(cvPath);
    if (!targetStems.has(stem)) {
      continue;
    }

    metadata.set(stem, {
      path: cvPath,
      locale: cleanOptional(row.locale),
      accents: cleanOptional(row.accents),
      variant: cleanOptional(row.variant),
      upVotes: parseOptionalNumber(row.up_votes),
      downVotes: parseOptionalNumber(row.down_votes),
    });

    if (metadata.size === targetStems.size) {
      break;
    }
  }

  return metadata;
}

function createCandidate(
  dataset: LanguageDataset,
  word: WordEntry,
  targetInfo: WordTargetInfo,
  row: MswcRow,
  commonVoice: CommonVoiceMetadata | undefined,
  mswcCode: string,
): MswcCandidate {
  const sourceId = `mswc:${mswcCode}:${row.link}`;
  const fileTitle = `MSWC ${mswcCode}/${row.link}`;
  const regions = detectRegions(dataset.id, commonVoice?.accents ?? "");
  const accentPolicy = createAccentPolicy(dataset.id, targetInfo, commonVoice?.accents, regions);
  const graphemeCheck = createGraphemeCheck(targetInfo);
  const reasons: string[] = ["MSWC clip found in local clips directory", "candidate matched by exact written form or safe unaccented directory lookup"];
  let score = 10;

  if (commonVoice) {
    score += 4;
    reasons.push("joined Common Voice metadata by clip filename stem");
  }

  if (accentPolicy.status === "preferred") {
    score += 30;
    reasons.push(...accentPolicy.notes);
  } else if (accentPolicy.status === "excluded") {
    score -= 100;
    reasons.push(...accentPolicy.notes);
  }

  const voteBalance = (commonVoice?.upVotes ?? 0) - (commonVoice?.downVotes ?? 0);

  if (voteBalance > 0) {
    score += Math.min(8, voteBalance);
    reasons.push(`Common Voice vote balance +${voteBalance}`);
  }

  const suggestedAudioSource = compactAudioSource({
    src: "",
    kind: "external",
    accent: regions[0] ?? commonVoice?.accents,
    license: COMMON_VOICE_LICENSE,
    attribution: COMMON_VOICE_ATTRIBUTION,
    sourceUrl: MSWC_SOURCE_URL,
    notes: [
      `MSWC grapheme-only candidate for target phoneme ${targetInfo.targetPhonemeIds.join(", ") || "unknown"}.`,
      commonVoice?.accents ? `Common Voice accent: ${commonVoice.accents}.` : undefined,
      accentPolicy.status === "excluded" ? "Accent excluded by merger-sensitive phoneme policy." : undefined,
    ].filter(Boolean).join(" "),
  });
  const candidate: MswcCandidate = {
    key: createCandidateKey({ wordId: word.id, fileTitle, sourceId }),
    sourceId,
    sourceName: MSWC_SOURCE_NAME,
    sourceUrl: MSWC_SOURCE_URL,
    fileTitle,
    audioUrl: null,
    license: COMMON_VOICE_LICENSE,
    licenseShortName: COMMON_VOICE_LICENSE,
    attribution: COMMON_VOICE_ATTRIBUTION,
    regions,
    targetPhonemeIds: targetInfo.targetPhonemeIds,
    targetPhonemes: targetInfo.targetPhonemes,
    targetContrasts: targetInfo.targetContrasts,
    graphemeCheck,
    accentPolicy,
    commonVoice,
    mswc: {
      languageCode: mswcCode,
      link: row.link,
      word: row.word,
    },
    score,
    reasons,
    suggestedAudioSource,
    review: {
      status: "pending",
      accent: regions[0] ?? commonVoice?.accents,
      notes: `Listen before approving. MSWC is grapheme-based; approve only if the recording clearly matches ${targetInfo.targetPhonemeIds.join(", ") || word.ipa}.`,
    },
  };

  return candidate;
}

function applyStoredReview(
  word: WordEntry,
  candidate: MswcCandidate,
  reviewState: AudioReviewState,
): MswcCandidate {
  const stored = getStoredReview(reviewState, {
    wordId: word.id,
    fileTitle: candidate.fileTitle,
    sourceId: candidate.sourceId,
    sourceUrl: candidate.sourceUrl,
  });

  if (!stored) {
    return candidate;
  }

  return {
    ...candidate,
    localPath: stored.localPath ?? candidate.localPath,
    metadataPath: stored.metadataPath ?? candidate.metadataPath,
    datasetSrc: stored.datasetSrc ?? candidate.datasetSrc,
    suggestedAudioSource: {
      ...candidate.suggestedAudioSource,
      ...stored.suggestedAudioSource,
      src: stored.datasetSrc ?? stored.suggestedAudioSource?.src ?? candidate.suggestedAudioSource.src,
    },
    review: {
      status: stored.status,
      accent: stored.accent ?? candidate.review.accent,
      notes: stored.notes ?? candidate.review.notes,
    },
  };
}

async function stageCandidate(
  word: WordEntry,
  candidate: MswcCandidate,
  row: MswcRow,
  opts: CliOptions,
): Promise<{ localPath: string; metadataPath: string; datasetSrc: string }> {
  const filename = sanitizeFilename(path.basename(row.link));
  const relativePath = path.join(opts.downloadDir, sanitizeFilename(word.id), filename);
  const metadataRelativePath = `${relativePath}.metadata.json`;

  await mkdir(path.dirname(path.resolve(relativePath)), { recursive: true });
  await copyFile(path.resolve(row.clipPath), path.resolve(relativePath));
  await writeJson(metadataRelativePath, {
    stagedAt: new Date().toISOString(),
    word: {
      id: word.id,
      written: word.written,
      ipa: word.ipa,
      phonemeIds: word.phonemeIds,
    },
    candidate: {
      ...candidate,
      localPath: relativePath,
      metadataPath: metadataRelativePath,
      datasetSrc: toDatasetAudioSrc(relativePath),
    },
  });

  return {
    localPath: relativePath,
    metadataPath: metadataRelativePath,
    datasetSrc: toDatasetAudioSrc(relativePath),
  };
}

function createWordTargetInfo(
  dataset: LanguageDataset,
  overrides: ReadonlyMap<string, readonly string[]>,
): Map<string, WordTargetInfo> {
  const phonemeById = new Map(dataset.phonemes.map((phoneme) => [phoneme.id, phoneme]));
  const byWord = new Map<string, { targetPhonemeIds: Set<string>; targetContrasts: Set<string> }>();

  for (const contrast of dataset.contrasts) {
    for (const pair of contrast.minimalPairs) {
      for (const term of pair.terms) {
        const info = byWord.get(term.wordId) ?? { targetPhonemeIds: new Set<string>(), targetContrasts: new Set<string>() };

        info.targetPhonemeIds.add(term.phonemeId);
        info.targetContrasts.add(contrast.id);
        byWord.set(term.wordId, info);
      }
    }
  }

  const result = new Map<string, WordTargetInfo>();

  for (const word of dataset.words) {
    const override = getTargetOverride(word, overrides);
    const rawInfo = byWord.get(word.id);
    const targetPhonemeIds = override ?? [...(rawInfo?.targetPhonemeIds ?? word.phonemeIds)];

    validateTargetPhonemes(word, targetPhonemeIds, phonemeById);
    result.set(word.id, {
      targetPhonemeIds,
      targetPhonemes: targetPhonemeIds.flatMap((id) => {
        const phoneme = phonemeById.get(id);

        return phoneme ? [{ id: phoneme.id, ipa: phoneme.ipa, label: phoneme.label }] : [];
      }),
      targetContrasts: [...(rawInfo?.targetContrasts ?? [])],
      override: Boolean(override),
    });
  }

  return result;
}

function createFallbackTargetInfo(word: WordEntry, dataset: LanguageDataset): WordTargetInfo {
  const phonemeById = new Map(dataset.phonemes.map((phoneme) => [phoneme.id, phoneme]));

  return {
    targetPhonemeIds: [...word.phonemeIds],
    targetPhonemes: word.phonemeIds.flatMap((id) => {
      const phoneme = phonemeById.get(id);

      return phoneme ? [{ id: phoneme.id, ipa: phoneme.ipa, label: phoneme.label }] : [];
    }),
    targetContrasts: [],
    override: false,
  };
}

function getTargetOverride(word: WordEntry, overrides: ReadonlyMap<string, readonly string[]>): string[] | null {
  return cloneOverride(overrides.get(word.id))
    ?? cloneOverride(overrides.get(normalizeExactText(word.written)))
    ?? cloneOverride(overrides.get(normalizeSearchText(word.written)));
}

function cloneOverride(value: readonly string[] | undefined): string[] | null {
  return value ? [...value] : null;
}

function validateTargetPhonemes(
  word: WordEntry,
  targetPhonemeIds: readonly string[],
  phonemeById: ReadonlyMap<string, Phoneme>,
): void {
  for (const phonemeId of targetPhonemeIds) {
    if (!phonemeById.has(phonemeId)) {
      throw new Error(`Unknown target phoneme ${phonemeId} for ${word.written}.`);
    }
  }
}

function createGraphemeCheck(targetInfo: WordTargetInfo): GraphemeCheck {
  return {
    status: targetInfo.override ? "target-selected" : "needs-review",
    notes: [
      "MSWC indexes clips by written form, not IPA, POS, sense, or accent-specific phoneme inventory.",
      `Manual approval must verify target phoneme ${targetInfo.targetPhonemeIds.join(", ") || "unknown"}.`,
      targetInfo.override ? "Target phoneme was selected explicitly on the command line." : undefined,
    ].filter((note): note is string => Boolean(note)),
  };
}

function createAccentPolicy(
  languageId: string,
  targetInfo: WordTargetInfo,
  accentText: string | undefined,
  regions: readonly string[],
): AccentPolicy {
  if (!sameLanguageId(languageId, "fr")) {
    return regions.some((region) => region === "British English")
      ? { status: "preferred", notes: ["Common Voice accent metadata suggests British English."] }
      : { status: "neutral", notes: [] };
  }

  if (regions.some((region) => region === "Swiss French" || region === "Belgian French")) {
    return { status: "preferred", notes: ["Swiss/Belgian French is prioritized when available."] };
  }

  if (isFrenchMergerSensitive(targetInfo) && isExplicitFranceFrenchAccent(accentText)) {
    return {
      status: "excluded",
      notes: ["French-from-France accent excluded for merger-sensitive contrast such as brun/brin."],
    };
  }

  return { status: "neutral", notes: [] };
}

function isFrenchMergerSensitive(targetInfo: WordTargetInfo): boolean {
  return targetInfo.targetContrasts.some((contrastId) => FRENCH_MERGER_SENSITIVE_CONTRASTS.has(contrastId));
}

function detectRegions(languageId: string, accentText: string): string[] {
  const haystack = normalizeSearchText(accentText);
  const regions: string[] = [];

  if (sameLanguageId(languageId, "fr")) {
    if (["suisse", "swiss", "switzerland", "romand", "romande", "fr-ch"].some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
      regions.push("Swiss French");
    }

    if (["belgique", "belge", "belgian", "belgium", "wallonie", "wallon", "walloon", "bruxelles", "brussels", "fr-be"].some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
      regions.push("Belgian French");
    }

    if (isExplicitFranceFrenchAccent(accentText)) {
      regions.push("France French");
    }
  }

  if (sameLanguageId(languageId, "en-GB")) {
    if (["british", "united kingdom", "england", "scotland", "wales", "northern ireland", "received pronunciation", " rp", "en-gb", "en-uk"].some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
      regions.push("British English");
    }
  }

  return regions;
}

function isExplicitFranceFrenchAccent(accentText: string | undefined): boolean {
  const haystack = normalizeSearchText(accentText ?? "");

  return ["france", "francais de france", "français de france", "french from france", "fr-fr"].some((keyword) =>
    haystack.includes(normalizeSearchText(keyword))
  );
}

function createSafeFallbackWordMap(words: readonly WordEntry[]): Map<string, WordEntry> {
  const candidates = new Map<string, WordEntry | null>();

  for (const word of words) {
    if (normalizeSearchText(word.written) !== normalizeExactText(word.written)) {
      continue;
    }

    const key = normalizeSearchText(word.written);
    const existing = candidates.get(key);

    if (existing === undefined) {
      candidates.set(key, word);
    } else {
      candidates.set(key, null);
    }
  }

  return new Map(
    [...candidates.entries()].filter((entry): entry is [string, WordEntry] => entry[1] !== null),
  );
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

  const languageId = getLanguageDataset(getLast(values, "language") ?? getLast(values, "lang")).id;
  const defaults = getLanguagePathDefaults(languageId);

  return {
    languageId,
    words: splitList([...(values.get("word") ?? []), ...(values.get("words") ?? [])]),
    limit: parseOptionalInteger(getLast(values, "limit")),
    output: getLast(values, "output") ?? defaults.report,
    markdown: values.has("no-markdown")
      ? null
      : getLast(values, "markdown") ?? defaults.markdown,
    mswcRoot: getLast(values, "mswc-root") ?? defaults.mswcRoot,
    cvValidated: values.has("no-cv")
      ? null
      : getLast(values, "cv-validated") ?? defaults.cvValidated,
    maxCandidatesPerWord: parseInteger(getLast(values, "max-candidates-per-word"), 8),
    download: parseDownloadMode(values),
    downloadDir: getLast(values, "download-dir") ?? defaults.downloadDir,
    reviewStatePath: getLast(values, "review-state") ?? defaults.reviewState,
    forceDownloadReviewed: values.has("force-download-reviewed") || values.has("force-copy-reviewed"),
    includeMergedFrance: values.has("include-merged-france"),
    targetPhonemeOverrides: parseTargetPhonemeOverrides(values.get("target-phoneme") ?? []),
  };
}

function printUsage(): void {
  console.log("Usage: bun run audio:mswc -- [options]");
  console.log("Options: --language=en-GB --words=ship,sheep --download=all|regional|none --max-candidates-per-word=6 --target-phoneme=live:en-gb-kit --include-merged-france --mswc-root=<path> --cv-validated=<path>");
}

function getLanguagePathDefaults(languageId: string): {
  report: string;
  markdown: string;
  mswcRoot: string;
  cvValidated: string;
  downloadDir: string;
  reviewState: string;
} {
  const slug = getLanguageSlug(languageId);
  const mswcCode = getMswcLanguageCode(languageId);

  return {
    report: `reports/${slug}-mswc-audio-candidates.json`,
    markdown: `reports/${slug}-mswc-audio-candidates.md`,
    mswcRoot: "../ml-commons-prototype/extracted/mswc_full",
    cvValidated: `../ml-commons-prototype/extracted/mozilla/cv-corpus-26.0-2026-06-12/${mswcCode}/validated.tsv`,
    downloadDir: `public/audio/${slug}/mswc`,
    reviewState: `reports/${slug}-mswc-audio-review-state.json`,
  };
}

function getMswcLanguageCode(languageId: string): string {
  if (sameLanguageId(languageId, "en-GB")) {
    return "en";
  }

  if (sameLanguageId(languageId, "fr")) {
    return "fr";
  }

  return languageId.toLowerCase().split("-")[0] ?? languageId.toLowerCase();
}

function selectWords(words: readonly WordEntry[], opts: CliOptions): WordEntry[] {
  const selected = opts.words.length > 0 ? selectRequestedWords(words, opts.words) : [...words];

  return opts.limit === null ? selected : selected.slice(0, opts.limit);
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

function parseDownloadMode(values: Map<string, string[]>): DownloadMode {
  if (!values.has("download")) {
    return "none";
  }

  const mode = getLast(values, "download");

  if (!mode || mode === "true") {
    return "regional";
  }

  if (mode === "all" || mode === "regional" || mode === "none") {
    return mode;
  }

  throw new Error(`Unknown download mode: ${mode}. Use --download=regional or --download=all.`);
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === delimiter && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current);

  return fields;
}

function recordFromFields(headers: readonly string[], fields: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(headers.map((header, index) => [header, fields[index]]));
}

function normalizeBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed || trimmed.toLowerCase() === "nan") {
    return undefined;
  }

  return trimmed;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : undefined;
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

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  return parseInteger(value, 0);
}

function normalizeExactText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeSearchText(value: string): string {
  return normalizeExactText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getStem(filePath: string): string {
  return path.basename(filePath).replace(/\.[^.]+$/, "");
}

function isAudioFilename(filename: string): boolean {
  const extension = filename.split(".").pop()?.toLowerCase();

  return Boolean(extension && AUDIO_EXTENSIONS.has(extension));
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function sanitizeFilename(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "audio";
}

function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

function compactAudioSource(source: AudioSource): AudioSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  ) as AudioSource;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function renderMarkdown(report: AudioReport): string {
  const lines = [
    "# MSWC Audio Candidate Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Language: ${report.language.name} (${report.language.id}; MSWC ${report.language.mswcCode})`,
    "",
    "## Summary",
    "",
    `- Words checked: ${report.summary.totalWords}`,
    `- Words with audio candidates: ${report.summary.wordsWithCandidates}`,
    `- Preferred accent candidates: ${report.summary.preferredAccentCandidates}`,
    `- Excluded French-from-France merger candidates: ${report.summary.excludedMergedFranceCandidates}`,
    `- Candidate files: ${report.summary.totalCandidates}`,
    `- Staged files: ${report.summary.stagedCandidates}`,
    "",
    "## Candidates",
    "",
  ];

  for (const word of report.words) {
    lines.push(`### ${word.written} ${word.ipa}`);
    lines.push("");
    lines.push(`Target phonemes: ${word.targetPhonemeIds.join(", ") || "unknown"}`);
    lines.push(`Target contrasts: ${word.targetContrasts.join(", ") || "none"}`);
    lines.push("");

    if (word.candidates.length === 0) {
      lines.push("No audio candidates found.");
      lines.push("");
      continue;
    }

    for (const candidate of word.candidates) {
      lines.push(`- ${candidate.fileTitle}`);
      lines.push(`  Source: ${candidate.sourceName} (${candidate.sourceId})`);
      lines.push(`  License: ${candidate.licenseShortName}`);
      lines.push(`  Attribution: ${candidate.attribution}`);
      lines.push(`  Regions: ${candidate.regions.length ? candidate.regions.join(", ") : "none detected"}`);
      lines.push(`  Grapheme check: ${candidate.graphemeCheck.status}; ${candidate.graphemeCheck.notes.join("; ")}`);
      lines.push(`  Accent policy: ${candidate.accentPolicy.status}${candidate.accentPolicy.notes.length ? `; ${candidate.accentPolicy.notes.join("; ")}` : ""}`);
      lines.push(`  Score: ${candidate.score} (${candidate.reasons.join("; ")})`);

      if (candidate.localPath) {
        lines.push(`  Local path: ${candidate.localPath}`);
      }

      if (candidate.metadataPath) {
        lines.push(`  Metadata: ${candidate.metadataPath}`);
      }

      lines.push(`  Review: ${candidate.review.status}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function printSummary(report: AudioReport, opts: CliOptions): void {
  console.log(`Checked ${report.summary.totalWords} ${report.language.name} words in MSWC ${report.language.mswcCode}.`);
  console.log(`Found ${report.summary.totalCandidates} candidates for ${report.summary.wordsWithCandidates} words.`);
  console.log(`Preferred accent candidates: ${report.summary.preferredAccentCandidates}.`);
  console.log(`Excluded French-from-France merger candidates: ${report.summary.excludedMergedFranceCandidates}.`);
  console.log(`Staged ${report.summary.stagedCandidates} candidates.`);
  console.log(`Wrote JSON report to ${opts.output}.`);

  if (opts.markdown) {
    console.log(`Wrote Markdown report to ${opts.markdown}.`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, value);
}
