import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { strFromU8, unzipSync } from "fflate";

import { getLanguageDataset, getLanguageSlug } from "../src/languages";
import type { AudioSource, LanguageDataset, WordEntry } from "../src/languages/types";
import { createCandidateKey } from "./audio-review-state";

interface CliOptions {
  bundles: string[];
  dryRun: boolean;
  report: string | null;
  stagingDir: string | null;
  review: boolean;
  apply: boolean;
  player: string | null;
  play: boolean;
  autoplay: boolean;
  includeReviewed: boolean;
}

interface ImportedContribution {
  dataset: LanguageDataset;
  word: WordEntry;
  shortWordId: string;
  reportPath: string;
}

interface ContributionManifestWord {
  id?: string;
  shortId?: string;
  written?: string;
  ipa?: string;
  phonemeIds?: string[];
  speechText?: string;
}

interface ContributionManifestRecording {
  id?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  recordedAt?: string;
  word?: ContributionManifestWord;
}

interface ContributionManifestContribution {
  licence?: "CC0-1.0" | "CC-BY-4.0";
  speakerName?: string;
  accent?: string;
}

interface ContributionManifest {
  version?: number;
  type?: string;
  id?: string;
  createdAt?: string;
  pageUrl?: string;
  language?: {
    id?: string;
    slug?: string;
    name?: string;
    autonym?: string;
  };
  word?: ContributionManifestWord;
  recording?: ContributionManifestRecording;
  recordings?: ContributionManifestRecording[];
  contribution?: ContributionManifestContribution;
}

interface NormalizedContributionRecording {
  manifest: ContributionManifest;
  bundleId: string;
  recordingId: string;
  recording: ContributionManifestRecording;
  word: WordEntry;
  shortWordId: string;
}

interface ContributionReport {
  version: 1;
  source: "contribution";
  generatedAt: string;
  language: {
    id: string;
    name: string;
  };
  words: ContributionReportWord[];
}

interface ContributionReportWord {
  wordId: string;
  written: string;
  ipa: string;
  phonemeIds: readonly string[];
  candidates: ContributionCandidate[];
}

interface ContributionCandidate {
  key: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  fileTitle: string;
  audioUrl: null;
  localPath: string;
  metadataPath: string;
  datasetSrc: string;
  license: string;
  licenseShortName: string;
  attribution?: string;
  regions?: string[];
  targetPhonemeIds: readonly string[];
  reasons: string[];
  suggestedAudioSource: AudioSource;
  review: {
    status: "pending";
    accent?: string;
    notes: string;
  };
}

const SOURCE_NAME = "Vowel Trowel user contribution";
const options = parseArgs(process.argv.slice(2));
const imported: ImportedContribution[] = [];

for (const bundlePath of options.bundles) {
  imported.push(...await importContributionBundle(bundlePath, options));
}

await reviewAndApplyImportedContributions(imported, options);

async function importContributionBundle(bundlePath: string, opts: CliOptions): Promise<ImportedContribution[]> {
  const zipEntries = unzipSync(new Uint8Array(await readFile(bundlePath)));
  const manifest = readManifest(zipEntries);
  const dataset = getLanguageDataset(manifest.language?.id);
  const slug = getLanguageSlug(dataset.id);
  const stagingDir = opts.stagingDir ?? `public/audio/${slug}/contributions`;
  const reportPath = opts.report ?? `reports/${slug}-contribution-audio-candidates.json`;
  const recordings = normalizeContributionRecordings(manifest, dataset, slug);
  const imported: ImportedContribution[] = [];

  validateLicence(manifest);

  for (const normalized of recordings) {
    const recordingFilename = requireString(normalized.recording.filename, "recording.filename");
    const recordingBasename = path.basename(recordingFilename);
    const recording = findZipEntry(zipEntries, recordingFilename);
    const extension = path.extname(recordingBasename) || extensionForMimeType(normalized.recording.mimeType);
    const localPath = path.join(
      stagingDir,
      sanitizeFilename(normalized.shortWordId),
      `${sanitizeFilename(normalized.recordingId)}${extension}`,
    );
    const metadataPath = `${localPath}.metadata.json`;
    const datasetSrc = toDatasetAudioSrc(localPath);
    const candidate = createCandidate(dataset, normalized, localPath, metadataPath, datasetSrc);

    if (opts.dryRun) {
      console.log(`Would import ${bundlePath}`);
      console.log(`Would write ${localPath}.`);
      console.log(`Would write ${metadataPath}.`);
      console.log(`Would update ${reportPath}.`);
    } else {
      await mkdir(path.dirname(path.resolve(localPath)), { recursive: true });
      await writeFile(localPath, recording);
      await writeJson(metadataPath, {
        importedAt: new Date().toISOString(),
        bundlePath,
        manifest,
        recording: normalized.recording,
        word: {
          id: normalized.word.id,
          written: normalized.word.written,
          ipa: normalized.word.ipa,
          phonemeIds: normalized.word.phonemeIds,
        },
        candidate,
      });

      const report = await loadContributionReport(reportPath, dataset);
      upsertCandidate(report, normalized.word, candidate);
      await writeJson(reportPath, report);
    }

    console.log(`${opts.dryRun ? "Checked" : "Imported"} contribution for ${normalized.word.written} (${normalized.word.id}).`);
    imported.push({ dataset, word: normalized.word, shortWordId: normalized.shortWordId, reportPath });
  }

  return imported;
}

async function reviewAndApplyImportedContributions(
  contributions: readonly ImportedContribution[],
  opts: CliOptions,
): Promise<void> {
  const groups = groupImportedContributions(contributions);

  for (const group of groups) {
    const wordList = [...new Set(group.contributions.map((contribution) => contribution.shortWordId))].join(",");
    const reviewArgs = [
      "run",
      "scripts/review-audio-candidates.ts",
      "--source=contribution",
      `--language=${group.dataset.id}`,
      `--report=${group.reportPath}`,
      `--words=${wordList}`,
    ];

    if (opts.player) {
      reviewArgs.push(`--player=${opts.player}`);
    }

    if (!opts.play) {
      reviewArgs.push("--no-play");
    }

    if (!opts.autoplay) {
      reviewArgs.push("--no-autoplay");
    }

    if (opts.includeReviewed) {
      reviewArgs.push("--include-reviewed");
    }

    const applyArgs = [
      "run",
      "scripts/apply-reviewed-audio.ts",
      "--source=contribution",
      `--language=${group.dataset.id}`,
      `--report=${group.reportPath}`,
    ];

    if (opts.dryRun) {
      console.log(`Would review imported contributions: bun ${reviewArgs.join(" ")}`);
      console.log(`Would apply approved contributions: bun ${applyArgs.join(" ")}`);
      continue;
    }

    if (opts.review) {
      runBun(reviewArgs);
    }

    if (opts.apply) {
      runBun(applyArgs);
    }
  }
}

function groupImportedContributions(contributions: readonly ImportedContribution[]): Array<{
  dataset: LanguageDataset;
  reportPath: string;
  contributions: ImportedContribution[];
}> {
  const groups = new Map<string, { dataset: LanguageDataset; reportPath: string; contributions: ImportedContribution[] }>();

  for (const contribution of contributions) {
    const key = `${contribution.dataset.id}\0${contribution.reportPath}`;
    const group = groups.get(key) ?? {
      dataset: contribution.dataset,
      reportPath: contribution.reportPath,
      contributions: [],
    };

    group.contributions.push(contribution);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function runBun(args: readonly string[]): void {
  const result = spawnSync("bun", args, { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`bun ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
  }
}

function readManifest(entries: Record<string, Uint8Array>): ContributionManifest {
  const manifestBytes = entries["manifest.json"];

  if (!manifestBytes) {
    throw new Error("Contribution bundle is missing manifest.json.");
  }

  const manifest = JSON.parse(strFromU8(manifestBytes)) as ContributionManifest;

  if ((manifest.version !== 1 && manifest.version !== 2) || manifest.type !== "vowel-trowel-contribution") {
    throw new Error("Contribution manifest has an unsupported version or type.");
  }

  return manifest;
}

function normalizeContributionRecordings(
  manifest: ContributionManifest,
  dataset: LanguageDataset,
  slug: string,
): NormalizedContributionRecording[] {
  if (manifest.version === 1) {
    const word = getManifestWord(dataset, manifest.word, "word");
    const shortWordId = stripWordPrefix(word.id, dataset.id);
    const bundleId = sanitizeFilename(manifest.id || createFallbackContributionId(slug, shortWordId));
    const recording = manifest.recording ?? {};

    validateManifestWord(word, manifest.word, "word");

    return [{
      manifest,
      bundleId,
      recordingId: bundleId,
      recording,
      word,
      shortWordId,
    }];
  }

  if (!Array.isArray(manifest.recordings) || manifest.recordings.length === 0) {
    throw new Error("Contribution manifest is missing recordings.");
  }

  const bundleId = sanitizeFilename(manifest.id || createFallbackContributionBatchId(slug));

  return manifest.recordings.map((recording, index) => {
    const word = getManifestWord(dataset, recording.word, `recordings[${index}].word`);
    const shortWordId = stripWordPrefix(word.id, dataset.id);
    const fallbackRecordingId = `${createFallbackContributionId(slug, shortWordId)}-${index + 1}`;
    const recordingId = sanitizeFilename(recording.id || fallbackRecordingId);

    validateManifestWord(word, recording.word, `recordings[${index}].word`);

    return {
      manifest,
      bundleId,
      recordingId,
      recording,
      word,
      shortWordId,
    };
  });
}

function getManifestWord(dataset: LanguageDataset, manifestWord: ContributionManifestWord | undefined, label: string): WordEntry {
  const wordId = requireString(manifestWord?.id, `${label}.id`);
  const word = dataset.words.find((candidate) => candidate.id === wordId);

  if (!word) {
    throw new Error(`Contribution word ${wordId} does not exist in ${dataset.id}.`);
  }

  return word;
}

function validateManifestWord(word: WordEntry, manifestWord: ContributionManifestWord | undefined, label: string): void {
  if (manifestWord?.written !== word.written) {
    throw new Error(`Contribution ${label}.written ${manifestWord?.written ?? "unknown"} does not match ${word.written}.`);
  }

  if (manifestWord?.ipa !== word.ipa) {
    throw new Error(`Contribution ${label}.ipa ${manifestWord?.ipa ?? "unknown"} does not match ${word.ipa}.`);
  }

  if (!sameStringList(manifestWord?.phonemeIds ?? [], word.phonemeIds)) {
    throw new Error(`Contribution ${label}.phonemeIds do not match ${word.id}.`);
  }
}

function validateLicence(manifest: ContributionManifest): void {
  const licence = manifest.contribution?.licence;
  const speakerName = manifest.contribution?.speakerName?.trim() ?? "";

  if (licence !== "CC0-1.0" && licence !== "CC-BY-4.0") {
    throw new Error(`Unsupported contribution licence ${licence ?? "unknown"}.`);
  }

  if (licence === "CC-BY-4.0" && !speakerName) {
    throw new Error("CC BY 4.0 contributions must include a speaker name for attribution.");
  }
}

function findZipEntry(entries: Record<string, Uint8Array>, filename: string): Uint8Array {
  const direct = entries[filename];

  if (direct) {
    return direct;
  }

  const match = Object.entries(entries).find(([entryName]) => path.basename(entryName) === filename)?.[1];

  if (!match) {
    throw new Error(`Contribution bundle is missing recording ${filename}.`);
  }

  return match;
}

function createCandidate(
  dataset: LanguageDataset,
  normalized: NormalizedContributionRecording,
  localPath: string,
  metadataPath: string,
  datasetSrc: string,
): ContributionCandidate {
  const { bundleId, manifest, recordingId, shortWordId, word } = normalized;
  const singleRecordingBundle = bundleId === recordingId;
  const sourceId = singleRecordingBundle
    ? `contribution:${dataset.id}:${recordingId}`
    : `contribution:${dataset.id}:${bundleId}:${recordingId}`;
  const sourceUrl = singleRecordingBundle
    ? `vowel-trowel-contribution:${recordingId}`
    : `vowel-trowel-contribution:${bundleId}:${recordingId}`;
  const licence = manifest.contribution?.licence === "CC-BY-4.0" ? "CC BY 4.0" : "CC0 1.0";
  const speakerName = manifest.contribution?.speakerName?.trim() || undefined;
  const accent = manifest.contribution?.accent?.trim() || undefined;
  const notes = `Listen before approving. User-contributed recording for ${word.written} ${word.ipa}.`;
  const suggestedAudioSource = compactAudioSource({
    src: datasetSrc,
    kind: "contribution",
    speaker: speakerName,
    accent,
    license: licence,
    attribution: speakerName,
    sourceUrl,
    notes: `User-contributed recording for ${word.written} ${word.ipa}.`,
  });
  const fileTitle = `User contribution ${shortWordId} ${recordingId}`;

  return {
    key: createCandidateKey({ wordId: word.id, fileTitle, sourceId }),
    sourceId,
    sourceName: SOURCE_NAME,
    sourceUrl,
    fileTitle,
    audioUrl: null,
    localPath,
    metadataPath,
    datasetSrc,
    license: licence,
    licenseShortName: licence,
    attribution: speakerName,
    regions: accent ? [accent] : undefined,
    targetPhonemeIds: word.phonemeIds,
    reasons: [
      "User-contributed recording bundle.",
      `Manifest created at ${manifest.createdAt ?? "unknown time"}.`,
      manifest.pageUrl ? `Recorded from ${manifest.pageUrl}.` : undefined,
    ].filter(Boolean) as string[],
    suggestedAudioSource,
    review: {
      status: "pending",
      accent,
      notes,
    },
  };
}

async function loadContributionReport(filePath: string, dataset: LanguageDataset): Promise<ContributionReport> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as ContributionReport;

    if (parsed.source === "contribution" && parsed.language?.id === dataset.id && Array.isArray(parsed.words)) {
      return parsed;
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  return {
    version: 1,
    source: "contribution",
    generatedAt: new Date().toISOString(),
    language: {
      id: dataset.id,
      name: dataset.name,
    },
    words: [],
  };
}

function upsertCandidate(report: ContributionReport, word: WordEntry, candidate: ContributionCandidate): void {
  report.generatedAt = new Date().toISOString();
  let reportWord = report.words.find((entry) => entry.wordId === word.id);

  if (!reportWord) {
    reportWord = {
      wordId: word.id,
      written: word.written,
      ipa: word.ipa,
      phonemeIds: word.phonemeIds,
      candidates: [],
    };
    report.words.push(reportWord);
  }

  const existingIndex = reportWord.candidates.findIndex((existing) =>
    existing.sourceId === candidate.sourceId || existing.datasetSrc === candidate.datasetSrc
  );

  if (existingIndex >= 0) {
    reportWord.candidates[existingIndex] = candidate;
  } else {
    reportWord.candidates.push(candidate);
  }

  report.words.sort((left, right) => left.wordId.localeCompare(right.wordId));
}

function parseArgs(args: string[]): CliOptions {
  const bundles: string[] = [];
  let dryRun = false;
  let report: string | null = null;
  let stagingDir: string | null = null;
  let review = true;
  let apply = true;
  let player: string | null = null;
  let play = true;
  let autoplay = true;
  let includeReviewed = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--no-review") {
      review = false;
      continue;
    }

    if (arg === "--no-apply") {
      apply = false;
      continue;
    }

    if (arg === "--no-play") {
      play = false;
      autoplay = false;
      continue;
    }

    if (arg === "--no-autoplay") {
      autoplay = false;
      continue;
    }

    if (arg === "--include-reviewed") {
      includeReviewed = true;
      continue;
    }

    if (arg.startsWith("--report=")) {
      report = arg.slice("--report=".length);
      continue;
    }

    if (arg.startsWith("--player=")) {
      player = arg.slice("--player=".length);
      continue;
    }

    if (arg.startsWith("--staging-dir=")) {
      stagingDir = arg.slice("--staging-dir=".length);
      continue;
    }

    if (!arg.startsWith("--")) {
      bundles.push(arg);
    }
  }

  if (bundles.length === 0) {
    throw new Error("Usage: bun run audio:import -- path/to/contribution.zip [more.zip] [--dry-run] [--no-review] [--no-apply]");
  }

  return { bundles, dryRun, report, stagingDir, review, apply, player, play, autoplay, includeReviewed };
}

function requireString(value: string | undefined, label: string): string {
  if (!value) {
    throw new Error(`Contribution manifest is missing ${label}.`);
  }

  return value;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function extensionForMimeType(mimeType: string | undefined): string {
  if (mimeType?.includes("ogg")) {
    return ".ogg";
  }

  if (mimeType?.includes("mp4") || mimeType?.includes("mpeg")) {
    return ".m4a";
  }

  if (mimeType?.includes("wav")) {
    return ".wav";
  }

  return ".webm";
}

function createFallbackContributionId(slug: string, shortWordId: string): string {
  return `${slug}-${shortWordId}-${Date.now().toString(36)}`;
}

function createFallbackContributionBatchId(slug: string): string {
  return `${slug}-batch-${Date.now().toString(36)}`;
}

function stripWordPrefix(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId.slice(prefix.length) : wordId;
}

function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

function sanitizeFilename(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "audio";
}

function compactAudioSource(source: AudioSource): AudioSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  ) as AudioSource;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
