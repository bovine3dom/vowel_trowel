import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { approvedBritishEnglishAudio } from "../src/languages/en-gb/audio";
import { approvedFrenchAudio } from "../src/languages/fr/audio";
import { getLanguageDataset, getLanguageSlug, sameLanguageId } from "../src/languages";
import type { AudioSource, LanguageDataset, WordEntry } from "../src/languages/types";
import {
  createCandidateKey,
  loadReviewState,
  saveReviewState,
  upsertStoredReview,
  type StoredCandidateReview,
} from "./audio-review-state";

interface CliOptions {
  input: string;
  dryRun: boolean;
  keepFile: boolean;
}

interface AudioFeedbackCode {
  v: 1;
  languageId: string;
  wordId: string;
  src: string;
}

type AudioCandidateSource = "wiktionary" | "mswc" | "contribution";

interface CandidateReport {
  words?: Array<{
    wordId?: string;
    written?: string;
    candidates?: Array<{
      datasetSrc?: string;
      localPath?: string;
      suggestedAudioSource?: AudioSource;
      review?: {
        status?: string;
        accent?: string;
        notes?: string;
      };
    }>;
  }>;
}

const options = parseArgs(process.argv.slice(2));
const src = normalizeAudioSrc(options.input);
const resolved = resolveApprovedSource(src);
const dataset = resolved.dataset;
const slug = getLanguageSlug(dataset.id);
const existingAudio = resolved.existingAudio;
const target = resolved.target;
const code: AudioFeedbackCode = {
  v: 1,
  languageId: dataset.id,
  wordId: fullWordIdFromAudioKey(target.wordId, dataset.id),
  src,
};
const shortWordId = stripWordPrefix(code.wordId, dataset.id);
const word = dataset.words.find((candidate) => candidate.id === code.wordId)
  ?? dataset.words.find((candidate) => stripWordPrefix(candidate.id, dataset.id) === shortWordId);

const removal = removeApprovedSource(existingAudio, code.src);
const updatedAudio = removal.audio;
const removedEntries = removal.wordIds.map((wordId) => {
  const fullWordId = fullWordIdFromAudioKey(wordId, dataset.id);
  const entry = dataset.words.find((candidate) => candidate.id === fullWordId);

  return { wordId: entry?.id ?? fullWordId, word: entry };
});
const outputPath = `src/languages/${slug}/audio.ts`;
const output = renderAudioModule(updatedAudio, dataset.id);
const publicAudioPath = toPublicAudioPath(target.source.src);
const shouldDeleteFile = Boolean(
  publicAudioPath
  && !options.keepFile
  && isInDirectory(publicAudioPath, `public/audio/${slug}/approved`)
  && !audioMapHasSrc(updatedAudio, target.source.src),
);
const rejectedSources = getRejectedSources(target.source);

console.log(`Blacklisting ${target.source.src}`);
console.log(`Language: ${dataset.name}`);
console.log(`Word: ${word?.written ?? shortWordId} (${code.wordId})`);
console.log(`Audio module: ${outputPath}`);
console.log(`Removed from: ${removal.wordIds.join(", ")}`);

if (options.dryRun) {
  console.log("Dry run: no files changed.");
  console.log(`Would remove source from ${outputPath}.`);
  if (shouldDeleteFile && publicAudioPath) {
    console.log(`Would delete ${publicAudioPath}.`);
  }
} else {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, output);
  console.log(`Wrote ${outputPath}.`);

  if (shouldDeleteFile && publicAudioPath) {
    await unlinkIfExists(publicAudioPath);
    await unlinkIfExists(`${publicAudioPath}.metadata.json`);
    console.log(`Deleted ${publicAudioPath}.`);
  }
}

for (const source of rejectedSources) {
  for (const entry of removedEntries) {
    await markRejectedInReviewState(source, { ...code, wordId: entry.wordId }, target.source, entry.word, options.dryRun);
  }

  await markRejectedInReport(source, code.src, options.dryRun);
}

function parseArgs(args: string[]): CliOptions {
  let input = "";
  let dryRun = false;
  let keepFile = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--keep-file") {
      keepFile = true;
      continue;
    }

    if (!arg.startsWith("--") && !input) {
      input = arg;
    }
  }

  if (!input) {
    throw new Error("Usage: bun run audio:blacklist -- <audio-filepath> [--dry-run] [--keep-file]");
  }

  return { input, dryRun, keepFile };
}

function normalizeAudioSrc(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const publicAudioIndex = normalized.indexOf("/public/audio/");

  if (publicAudioIndex >= 0) {
    return normalized.slice(publicAudioIndex + "/public/".length);
  }

  if (normalized.startsWith("public/audio/")) {
    return normalized.slice("public/".length);
  }

  if (normalized.startsWith("/audio/")) {
    return normalized.slice(1);
  }

  return normalized;
}

function cloneAudioMap(source: Record<string, readonly AudioSource[]>): Record<string, AudioSource[]> {
  return Object.fromEntries(
    Object.entries(source).map(([wordId, sources]) => [wordId, sources.map((audio) => ({ ...audio }))]),
  );
}

function getExistingAudio(languageId: string): Record<string, readonly AudioSource[]> {
  return sameLanguageId(languageId, "en-GB") ? approvedBritishEnglishAudio : approvedFrenchAudio;
}

function resolveApprovedSource(src: string): {
  dataset: LanguageDataset;
  existingAudio: Record<string, AudioSource[]>;
  target: { wordId: string; source: AudioSource };
} {
  const datasets = [getLanguageDataset("fr"), getLanguageDataset("en-GB")];

  for (const candidateDataset of datasets) {
    const existingAudio = cloneAudioMap(getExistingAudio(candidateDataset.id));
    const target = findApprovedSource(existingAudio, src);

    if (target) {
      return { dataset: candidateDataset, existingAudio, target };
    }
  }

  throw new Error(`Could not find approved audio source ${src}.`);
}

function findApprovedSource(
  audio: Record<string, AudioSource[]>,
  src: string,
): { wordId: string; source: AudioSource } | null {
  for (const [wordId, sources] of Object.entries(audio)) {
    const source = sources.find((candidate) => candidate.src === src);

    if (source) {
      return { wordId, source };
    }
  }

  return null;
}

function removeApprovedSource(
  audio: Record<string, AudioSource[]>,
  src: string,
): { audio: Record<string, AudioSource[]>; wordIds: string[] } {
  const updated: Record<string, AudioSource[]> = {};
  const wordIds: string[] = [];

  for (const [wordId, sources] of Object.entries(audio)) {
    const filtered = sources.filter((source) => source.src !== src);

    if (filtered.length !== sources.length) {
      wordIds.push(wordId);
    }

    updated[wordId] = filtered;
  }

  return { audio: sortAudioMap(updated), wordIds };
}

function sortAudioMap(map: Record<string, AudioSource[]>): Record<string, AudioSource[]> {
  return Object.fromEntries(
    Object.entries(map)
      .map(([wordId, sources]) => [wordId, sources] as const)
      .filter(([, sources]) => sources.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function audioMapHasSrc(audio: Record<string, AudioSource[]>, src: string): boolean {
  return Object.values(audio).some((sources) => sources.some((source) => source.src === src));
}

function renderAudioModule(audio: Record<string, AudioSource[]>, languageId: string): string {
  const exportName = sameLanguageId(languageId, "en-GB")
    ? "approvedBritishEnglishAudio"
    : "approvedFrenchAudio";

  return `import type { AudioSource } from "../types";\n\nexport const ${exportName}: Record<string, readonly AudioSource[]> = ${JSON.stringify(audio, null, 2)};\n`;
}

function stripWordPrefix(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId.slice(prefix.length) : wordId;
}

function fullWordIdFromAudioKey(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId : `${prefix}${wordId}`;
}

function getRejectedSources(source: AudioSource): AudioCandidateSource[] {
  if (source.kind === "contribution" || source.sourceUrl?.startsWith("vowel-trowel-contribution:")) {
    return ["contribution"];
  }

  if (source.kind === "wiktionary" || source.sourceUrl?.includes("commons.wikimedia.org")) {
    return ["wiktionary"];
  }

  if (source.sourceUrl?.includes("mlcommons.org") || source.attribution?.includes("MLCommons")) {
    return ["mswc"];
  }

  return ["wiktionary", "mswc", "contribution"];
}

function getReviewSourceName(source: AudioCandidateSource): string {
  if (source === "mswc") {
    return "MLCommons Multilingual Spoken Words Corpus";
  }

  if (source === "contribution") {
    return "Vowel Trowel user contribution";
  }

  return "Wikimedia Commons";
}

async function markRejectedInReviewState(
  source: AudioCandidateSource,
  code: AudioFeedbackCode,
  audioSource: AudioSource,
  word: WordEntry | undefined,
  dryRun: boolean,
): Promise<void> {
  const reviewStatePath = getReviewStatePath(dataset.id, source);
  const identity = createRejectedIdentity(source, code, audioSource);
  const key = createCandidateKey(identity);
  const review: StoredCandidateReview = {
    key,
    wordId: code.wordId,
    written: word?.written ?? stripWordPrefix(code.wordId, dataset.id),
    fileTitle: identity.fileTitle,
    sourceId: identity.sourceId,
    sourceName: getReviewSourceName(source),
    sourceUrl: identity.sourceUrl,
    commonsUrl: identity.commonsUrl,
    localPath: toPublicAudioPath(audioSource.src) ?? undefined,
    datasetSrc: audioSource.src,
    suggestedAudioSource: audioSource,
    status: "rejected",
    accent: audioSource.accent,
    notes: "Blacklisted from user feedback code.",
    reviewedAt: new Date().toISOString(),
  };

  if (dryRun) {
    console.log(`Would mark rejected in ${reviewStatePath}.`);
    return;
  }

  const state = await loadReviewState(reviewStatePath);
  await saveReviewState(upsertStoredReview(state, review), reviewStatePath);
  console.log(`Marked rejected in ${reviewStatePath}.`);
}

function createRejectedIdentity(
  source: AudioCandidateSource,
  code: AudioFeedbackCode,
  audioSource: AudioSource,
): { wordId: string; fileTitle: string; sourceId?: string; sourceUrl?: string; commonsUrl?: string } {
  const basename = path.basename(code.src);

  if (source === "mswc") {
    const mswcCode = getMswcLanguageCode(code.languageId);
    return {
      wordId: code.wordId,
      fileTitle: `MSWC ${mswcCode}/${basename}`,
      sourceId: `mswc:${mswcCode}:${basename}`,
      sourceUrl: audioSource.sourceUrl,
    };
  }

  if (source === "contribution") {
    return {
      wordId: code.wordId,
      fileTitle: `User contribution ${basename}`,
      sourceId: audioSource.sourceUrl?.startsWith("vowel-trowel-contribution:")
        ? audioSource.sourceUrl
        : `contribution:${code.languageId}:${basename}`,
      sourceUrl: audioSource.sourceUrl,
    };
  }

  const commonsUrl = audioSource.sourceUrl?.includes("commons.wikimedia.org") ? audioSource.sourceUrl : undefined;

  return {
    wordId: code.wordId,
    fileTitle: inferCommonsFileTitle(audioSource.sourceUrl) ?? basename,
    sourceUrl: audioSource.sourceUrl,
    commonsUrl,
  };
}

async function markRejectedInReport(source: AudioCandidateSource, datasetSrc: string, dryRun: boolean): Promise<void> {
  const reportPath = getReportPath(dataset.id, source);
  let report: CandidateReport;

  try {
    report = JSON.parse(await readFile(reportPath, "utf8")) as CandidateReport;
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw error;
  }

  let changed = false;

  for (const word of report.words ?? []) {
    for (const candidate of word.candidates ?? []) {
      if (candidate.datasetSrc !== datasetSrc && candidate.suggestedAudioSource?.src !== datasetSrc) {
        continue;
      }

      candidate.review = {
        ...candidate.review,
        status: "rejected",
        notes: appendNote(candidate.review?.notes, "Blacklisted from user feedback code."),
      };
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  if (dryRun) {
    console.log(`Would mark rejected in ${reportPath}.`);
    return;
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Marked rejected in ${reportPath}.`);
}

function appendNote(current: string | undefined, note: string): string {
  return current?.includes(note) ? current : [current, note].filter(Boolean).join(" ");
}

function getReportPath(languageId: string, source: AudioCandidateSource): string {
  return `reports/${getReportPrefix(languageId, source)}-audio-candidates.json`;
}

function getReviewStatePath(languageId: string, source: AudioCandidateSource): string {
  return `reports/${getReportPrefix(languageId, source)}-audio-review-state.json`;
}

function getReportPrefix(languageId: string, source: AudioCandidateSource): string {
  if (source === "wiktionary" && sameLanguageId(languageId, "fr")) {
    return "wiktionary";
  }

  return `${getLanguageSlug(languageId)}-${source}`;
}

function getMswcLanguageCode(languageId: string): string {
  return sameLanguageId(languageId, "en-GB") ? "en" : getLanguageSlug(languageId);
}

function inferCommonsFileTitle(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) {
    return undefined;
  }

  const match = sourceUrl.match(/(?:File:|Fichier:)([^/?#]+)/i);
  const title = match?.[1];

  return title ? `File:${decodeURIComponent(title).replace(/_/g, " ")}` : undefined;
}

function toPublicAudioPath(src: string): string | null {
  const normalized = src.replace(/\\/g, "/").replace(/^\.\//, "");

  if (/^(https?:|data:|blob:|\/)/.test(normalized)) {
    return null;
  }

  return normalized.startsWith("public/") ? normalized : path.join("public", normalized);
}

function isInDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
