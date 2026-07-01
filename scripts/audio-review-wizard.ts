import { spawnSync } from "node:child_process";

import { getLanguageDataset } from "../src/languages";
import type { WordEntry } from "../src/languages/types";

type DownloadMode = "none" | "regional" | "all";

interface CliOptions {
  languageId: string;
  words: string[];
  limit: number | null;
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
  dryRun: boolean;
}

const options = parseArgs(process.argv.slice(2));
const dataset = getLanguageDataset(options.languageId);
const candidates = options.words.length > 0
  ? selectRequestedWords(dataset.words, options.words)
  : dataset.words.filter((word) => word.audio.length === 0);
const selectedWords = options.limit === null ? candidates : candidates.slice(0, options.limit);

if (selectedWords.length === 0) {
  console.log(options.words.length > 0
    ? "No matching words found. Check spelling or word IDs."
    : "Every word in this language already has at least one approved recording.");
  process.exit(0);
}

console.log(`Language: ${dataset.name}`);
console.log(`Words: ${selectedWords.map((word) => word.written).join(", ")}`);

if (candidates.length > selectedWords.length) {
  console.log(`Showing ${selectedWords.length} of ${candidates.length}. Pass --all or raise --limit to review more.`);
}

if (options.dryRun) {
  process.exit(0);
}

const wordsArg = selectedWords.map((word) => word.written).join(",");

if (options.download !== "none") {
  runStep(1, 3, "Finding and downloading candidate recordings", "scripts/wiktionary-audio-report.ts", compactArgs([
    `--language=${dataset.id}`,
    `--words=${wordsArg}`,
    `--download=${options.download}`,
    `--max-candidates-per-word=${options.maxCandidatesPerWord}`,
    options.includeIpaMismatches ? "--include-ipa-mismatches" : null,
    options.progress ? null : "--no-progress",
    options.email ? `--email=${options.email}` : null,
  ]));
}

if (options.review) {
  runStep(2, 3, "Reviewing downloaded candidates", "scripts/review-audio-candidates.ts", compactArgs([
    `--language=${dataset.id}`,
    `--words=${wordsArg}`,
    options.reviewLimit === null ? null : `--limit=${options.reviewLimit}`,
    options.includeReviewed ? "--include-reviewed" : null,
    options.play ? null : "--no-play",
  ]));
}

if (options.apply) {
  runStep(3, 3, "Applying approved recordings", "scripts/apply-reviewed-audio.ts", [
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

  return {
    languageId: getLanguageDataset(getLast(values, "language") ?? getLast(values, "lang")).id,
    words: splitList([...(values.get("word") ?? []), ...(values.get("words") ?? [])]),
    limit: values.has("all") ? null : parseOptionalInteger(getLast(values, "limit") ?? "12"),
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
    dryRun: values.has("dry-run"),
  };
}

function printUsage(): void {
  console.log("Usage: bun run audio:wizard -- [options]");
  console.log("Default: first 12 words missing recordings, download up to 4 candidates each, review, then apply approvals.");
  console.log("Options: --language=en-GB --words=ship,sheep --limit=20 --all --download=all|regional|none --max-candidates-per-word=6 --review-limit=20 --include-ipa-mismatches --no-progress --no-play --no-review --no-apply --dry-run");
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
