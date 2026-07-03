import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { approvedBritishEnglishAudio } from "../src/languages/en-gb/audio";
import { approvedFrenchAudio } from "../src/languages/fr/audio";
import { getLanguageDataset, getLanguageSlug, sameLanguageId } from "../src/languages";
import type { AudioSource } from "../src/languages/types";

interface CliOptions {
  languageId: string;
  source: AudioCandidateSource;
  report: string;
  output: string | null;
  approvedDir: string | null;
  dryRun: boolean;
  existingOnly: boolean;
}

type AudioCandidateSource = "wiktionary" | "mswc" | "contribution";

interface ReviewedReport {
  language?: {
    id?: string;
  };
  words?: ReviewedWord[];
}

interface ReviewedWord {
  wordId: string;
  written: string;
  candidates?: ReviewedCandidate[];
}

interface ReviewedCandidate {
  sourceId?: string;
  sourceName?: string;
  sourceUrl?: string;
  fileTitle?: string;
  commonsUrl?: string;
  license?: string | null;
  licenseShortName?: string | null;
  attribution?: string | null;
  artist?: string | null;
  credit?: string | null;
  regions?: string[];
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
  suggestedAudioSource?: AudioSource;
  review?: {
    status?: string;
    accent?: string;
    notes?: string;
  };
}

const options = parseArgs(process.argv.slice(2));
const report = options.existingOnly
  ? { language: { id: options.languageId }, words: [] }
  : JSON.parse(await readFile(options.report, "utf8")) as ReviewedReport;
const languageId = report.language?.id ? getLanguageDataset(report.language.id).id : options.languageId;
const defaults = getLanguagePathDefaults(languageId, options.source);
const outputPath = options.output ?? defaults.output;
const approvedDir = options.approvedDir ?? defaults.approvedDir;
const merged = mergeApprovedAudio(getExistingAudio(languageId), report, languageId, approvedDir);
const approvedAudio = await copyApprovedAudio(merged, approvedDir, options.dryRun);
const output = renderAudioModule(approvedAudio, languageId);

if (options.dryRun) {
  console.log(output);
} else {
  await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await writeFile(outputPath, output);
  console.log(`Wrote ${outputPath}.`);
}

function mergeApprovedAudio(
  existing: Record<string, readonly AudioSource[]>,
  report: ReviewedReport,
  languageId: string,
  approvedDir: string,
): Record<string, AudioSource[]> {
  const merged = Object.fromEntries(
    Object.entries(existing).map(([wordId, sources]) => [
      wordId,
      dedupeAudioSources(sources.filter((source) => isApprovedAppAudioSource(source, approvedDir))),
    ]),
  ) as Record<string, AudioSource[]>;

  for (const word of report.words ?? []) {
    const shortWordId = stripWordPrefix(word.wordId, languageId);

    for (const candidate of word.candidates ?? []) {
      if (!isApproved(candidate)) {
        continue;
      }

      const source = createAudioSource(candidate);
      const existingSources = merged[shortWordId] ?? [];

      merged[shortWordId] = dedupeAudioSources([...existingSources, source]);
    }
  }

  return sortAudioMap(merged);
}

function createAudioSource(candidate: ReviewedCandidate): AudioSource {
  const suggested = candidate.suggestedAudioSource;

  if (!suggested?.src) {
    throw new Error(`Approved candidate ${candidate.fileTitle ?? "unknown"} has no suggestedAudioSource.src.`);
  }

  return compactAudioSource({
    src: suggested.src,
    kind: suggested.kind ?? "external",
    speaker: suggested.speaker,
    accent: candidate.review?.accent ?? candidate.regions?.[0] ?? suggested.accent,
    license: suggested.license ?? candidate.licenseShortName ?? candidate.license ?? undefined,
    attribution: suggested.attribution ?? candidate.attribution ?? candidate.artist ?? candidate.credit ?? undefined,
    sourceUrl: suggested.sourceUrl ?? candidate.sourceUrl ?? candidate.commonsUrl,
    notes: candidate.review?.notes ?? suggested.notes,
  });
}

function compactAudioSource(source: AudioSource): AudioSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  ) as unknown as AudioSource;
}

function isApproved(candidate: ReviewedCandidate): boolean {
  return candidate.review?.status === "approved";
}

function stripWordPrefix(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId.slice(prefix.length) : wordId;
}

function sortAudioMap(map: Record<string, AudioSource[]>): Record<string, AudioSource[]> {
  return Object.fromEntries(
    Object.entries(map)
      .map(([wordId, sources]) => [wordId, dedupeAudioSources(sources)] as const)
      .filter(([, sources]) => sources.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function copyApprovedAudio(
  audio: Record<string, AudioSource[]>,
  approvedDir: string,
  dryRun: boolean,
): Promise<Record<string, AudioSource[]>> {
  const copied: Record<string, AudioSource[]> = {};

  for (const [wordId, sources] of Object.entries(audio)) {
    copied[wordId] = [];

    for (const source of sources) {
      copied[wordId]?.push(await copyApprovedSource(wordId, source, approvedDir, dryRun));
    }

    copied[wordId] = dedupeAudioSources(copied[wordId] ?? []);
  }

  return sortAudioMap(copied);
}

function isApprovedAppAudioSource(source: AudioSource, approvedDir: string): boolean {
  const publicAudioPath = toPublicAudioPath(source.src);

  return !publicAudioPath || isInDirectory(publicAudioPath, approvedDir);
}

function dedupeAudioSources(sources: readonly AudioSource[]): AudioSource[] {
  const orderedKeys: string[] = [];
  const byKey = new Map<string, AudioSource>();

  for (const source of sources) {
    const key = audioSourceDedupeKey(source);

    if (!byKey.has(key)) {
      orderedKeys.push(key);
    }

    byKey.set(key, source);
  }

  return orderedKeys
    .map((key) => byKey.get(key))
    .filter((source): source is AudioSource => Boolean(source));
}

function audioSourceDedupeKey(source: AudioSource): string {
  if ((source.kind === "contribution" || source.kind === "wiktionary") && source.sourceUrl) {
    return `${source.kind}:${source.sourceUrl}`;
  }

  return `src:${source.src}`;
}

async function copyApprovedSource(
  wordId: string,
  source: AudioSource,
  approvedDir: string,
  dryRun: boolean,
): Promise<AudioSource> {
  const inputPath = toPublicAudioPath(source.src);

  if (!inputPath || !isAudioStagingPath(inputPath) || isInDirectory(inputPath, approvedDir)) {
    return source;
  }

  const outputPath = path.join(approvedDir, sanitizeFilename(wordId), path.basename(inputPath));

  if (!dryRun) {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await copyFile(path.resolve(inputPath), path.resolve(outputPath));
    await copyMetadataFile(inputPath, outputPath);
  }

  return {
    ...source,
    src: toDatasetAudioSrc(outputPath),
  };
}

async function copyMetadataFile(inputPath: string, outputPath: string): Promise<void> {
  try {
    await copyFile(path.resolve(`${inputPath}.metadata.json`), path.resolve(`${outputPath}.metadata.json`));
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function toPublicAudioPath(src: string): string | null {
  const normalized = src.replace(/\\/g, "/").replace(/^\.\//, "");

  if (/^(https?:|data:|blob:|\/)/.test(normalized)) {
    return null;
  }

  return normalized.startsWith("public/") ? normalized : path.join("public", normalized);
}

function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

function isAudioStagingPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.includes("/wiktionary/")
    || normalized.includes("/mswc/")
    || normalized.includes("/contributions/");
}

function isInDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeFilename(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "audio";
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getExistingAudio(languageId: string): Record<string, readonly AudioSource[]> {
  return sameLanguageId(languageId, "en-GB") ? approvedBritishEnglishAudio : approvedFrenchAudio;
}

function renderAudioModule(audio: Record<string, AudioSource[]>, languageId: string): string {
  const exportName = sameLanguageId(languageId, "en-GB")
    ? "approvedBritishEnglishAudio"
    : "approvedFrenchAudio";

  return `import type { AudioSource } from "../types";\n\nexport const ${exportName}: Record<string, readonly AudioSource[]> = ${JSON.stringify(audio, null, 2)};\n`;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, ...rest] = arg.slice(2).split("=");
    values.set(rawKey ?? "", rest.length > 0 ? rest.join("=") : "true");
  }

  const languageId = getLanguageDataset(values.get("language") ?? values.get("lang")).id;
  const source = parseSource(values.get("source"));
  const defaults = getLanguagePathDefaults(languageId, source);

  return {
    languageId,
    source,
    report: values.get("report") ?? defaults.report,
    output: values.get("output") ?? null,
    approvedDir: values.get("approved-dir") ?? null,
    dryRun: values.get("dry-run") === "true",
    existingOnly: values.get("existing-only") === "true",
  };
}

function getLanguagePathDefaults(languageId: string, source: AudioCandidateSource): { report: string; output: string; approvedDir: string } {
  const slug = getLanguageSlug(languageId);
  const reportPrefix = getReportPrefix(languageId, source);

  return {
    report: `reports/${reportPrefix}-audio-candidates.json`,
    output: `src/languages/${slug}/audio.ts`,
    approvedDir: `public/audio/${slug}/approved`,
  };
}

function getReportPrefix(languageId: string, source: AudioCandidateSource): string {
  if (source === "wiktionary" && sameLanguageId(languageId, "fr")) {
    return "wiktionary";
  }

  return `${getLanguageSlug(languageId)}-${source}`;
}

function parseSource(value: string | undefined): AudioCandidateSource {
  if (!value || value === "wiktionary") {
    return "wiktionary";
  }

  if (value === "mswc" || value === "contribution") {
    return value;
  }

  throw new Error(`Expected --source=wiktionary, --source=mswc, or --source=contribution; got ${value}.`);
}
