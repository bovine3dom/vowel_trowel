import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";

import { getLanguageDataset, getLanguageSlug, sameLanguageId } from "../src/languages";
import type { AudioSource } from "../src/languages/types";
import {
  DEFAULT_REVIEW_STATE_PATH,
  createCandidateKey,
  getStoredReview,
  loadReviewState,
  saveReviewState,
  upsertStoredReview,
  type AudioReviewState,
  type AudioReviewStatus,
  type StoredCandidateReview,
} from "./audio-review-state";

interface CliOptions {
  languageId: string;
  report: string;
  reviewStatePath: string;
  player: string | null;
  play: boolean;
  autoplay: boolean;
  includeReviewed: boolean;
  words: string[];
  limit: number | null;
}

interface ReviewedReport {
  words?: ReviewedWord[];
}

interface ReviewedWord {
  wordId: string;
  written: string;
  ipa?: string;
  phonemeIds?: readonly string[];
  candidates?: ReviewedCandidate[];
}

interface ReviewedCandidate {
  key?: string;
  fileTitle?: string;
  commonsUrl?: string;
  audioUrl?: string | null;
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
  license?: string | null;
  licenseShortName?: string | null;
  attribution?: string | null;
  artist?: string | null;
  credit?: string | null;
  regions?: string[];
  wiktionaryIpaClaims?: Array<{
    ipa?: string;
    wiki?: string;
    pageTitle?: string;
    context?: string;
  }>;
  ipaCheck?: {
    status?: string;
    expected?: string;
    claimed?: string[];
    matched?: string[];
  };
  sourceWikis?: string[];
  score?: number;
  reasons?: string[];
  suggestedAudioSource?: AudioSource;
  review?: {
    status?: string;
    accent?: string;
    notes?: string;
  };
}

interface CandidateWithIdentity extends ReviewedCandidate {
  fileTitle: string;
  commonsUrl: string;
}

interface ReviewableCandidate extends CandidateWithIdentity {
  localPath: string;
}

interface ReviewItem {
  word: ReviewedWord;
  candidate: ReviewableCandidate;
}

interface PlayerSpec {
  command: string;
  args: string[];
}

type ReviewOutcome = "reviewed" | "skipped" | "skip-word" | "undo" | "quit";

interface DecisionHistoryEntry {
  item: ReviewItem;
  previousCandidate: ReviewableCandidate;
  previousStoredReview?: StoredCandidateReview;
}

const options = parseArgs(process.argv.slice(2));
const report = JSON.parse(await readFile(options.report, "utf8")) as ReviewedReport;
let reviewState = await loadReviewState(options.reviewStatePath);
const decisionHistory: DecisionHistoryEntry[] = [];

const mergedStoredReviews = applyStoredReviewsToReport(report, reviewState);
const synced = syncReportReviewsToState(report, reviewState);
reviewState = synced.state;

if (mergedStoredReviews) {
  await writeJson(options.report, report);
}

if (synced.changed) {
  await saveReviewState(reviewState, options.reviewStatePath);
}

const items = getReviewItems(report, options);

if (items.length === 0) {
  console.log("No downloaded pending candidates found for review.");
  process.exit(0);
}

const player = options.play ? resolvePlayer(options.player) : null;

if (options.play && !player) {
  throw new Error("No audio player found. Install mpv, ffplay, or sox/play; pass --player=<command>; or use --no-play.");
}

const rl = createInterface({ input, output });

try {
  let reviewed = 0;
  let index = 0;

  console.log(`Reviewing ${items.length} downloaded candidate${items.length === 1 ? "" : "s"}.`);

  while (index < items.length) {
    const item = items[index];

    if (!item) {
      index += 1;
      continue;
    }

    const outcome = await reviewItem(item, index + 1, items.length, rl, player, options);

    if (outcome === "reviewed") {
      reviewed += 1;
      index += 1;
      continue;
    }

    if (outcome === "skipped") {
      index += 1;
      continue;
    }

    if (outcome === "skip-word") {
      const wordId = item.word.wordId;

      while (index < items.length && items[index]?.word.wordId === wordId) {
        index += 1;
      }

      continue;
    }

    if (outcome === "undo") {
      const undone = await undoLastDecision();

      if (undone) {
        const undoneIndex = items.indexOf(undone);
        index = undoneIndex >= 0 ? undoneIndex : index;
        reviewed = Math.max(0, reviewed - 1);
      }

      continue;
    }

    if (outcome === "quit") {
      break;
    }
  }

  console.log(`Reviewed ${reviewed} candidate${reviewed === 1 ? "" : "s"}.`);
  console.log(`Updated ${options.report} and ${options.reviewStatePath}.`);
} finally {
  rl.close();
}

async function reviewItem(
  item: ReviewItem,
  index: number,
  total: number,
  rl: Interface,
  player: PlayerSpec | null,
  opts: CliOptions,
): Promise<ReviewOutcome> {
  printCandidate(item, index, total);

  if (player && opts.autoplay) {
    await playCandidate(player, item.candidate.localPath);
  }

  while (true) {
    const command = await readCommandKey(rl, "Choice [a]pprove [r]eject [s]kip [w]ord [p]lay [u]ndo [q]uit: ");

    if (command === "p") {
      if (!player) {
        console.log("Playback is disabled for this run.");
        continue;
      }

      await playCandidate(player, item.candidate.localPath);
      continue;
    }

    if (command === "s") {
      return "skipped";
    }

    if (command === "w") {
      return "skip-word";
    }

    if (command === "u") {
      return "undo";
    }

    if (command === "q") {
      return "quit";
    }

    if (command === "a") {
      await saveDecision(
        item,
        "approved",
        item.candidate.review?.accent ?? item.candidate.regions?.[0],
        meaningfulNotes(item.candidate.review?.notes),
      );
      console.log("Approved.");
      return "reviewed";
    }

    if (command === "r") {
      await saveDecision(
        item,
        "rejected",
        item.candidate.review?.accent,
        meaningfulNotes(item.candidate.review?.notes) ?? "Rejected during audio review.",
      );
      console.log("Rejected.");
      return "reviewed";
    }

    console.log("Unknown choice. Use a, r, s, w, p, u, or q.");
  }
}

async function readCommandKey(rl: Interface, prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return ((await rl.question(prompt)).trim().toLowerCase()[0] ?? "");
  }

  emitKeypressEvents(input);
  output.write(prompt);

  return await new Promise((resolve) => {
    const wasRaw = input.isRaw;

    input.setRawMode(true);
    input.resume();

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(Boolean(wasRaw));
    };
    const onKeypress = (sequence: string, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        output.write("q\n");
        resolve("q");
        return;
      }

      const command = sequence.toLowerCase()[0];

      if (!command || command === "\r" || command === "\n") {
        return;
      }

      cleanup();
      output.write(`${command}\n`);
      resolve(command);
    };

    input.on("keypress", onKeypress);
  });
}

async function promptApprovalDetails(
  rl: Interface,
  candidate: ReviewedCandidate,
): Promise<{ accent?: string; notes?: string }> {
  const accent = await askWithDefault(
    rl,
    "Accent",
    candidate.review?.accent ?? candidate.regions?.[0],
  );
  const notes = await askWithDefault(rl, "Notes", meaningfulNotes(candidate.review?.notes));

  return { accent, notes };
}

async function askWithDefault(
  rl: Interface,
  label: string,
  defaultValue: string | undefined,
): Promise<string | undefined> {
  const prompt = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
  const answer = (await rl.question(prompt)).trim();

  return answer || defaultValue;
}

async function saveDecision(
  item: ReviewItem,
  status: AudioReviewStatus,
  accent: string | undefined,
  notes: string | undefined,
): Promise<void> {
  const key = createCandidateKey({
    wordId: item.word.wordId,
    fileTitle: item.candidate.fileTitle,
    commonsUrl: item.candidate.commonsUrl,
  });

  decisionHistory.push({
    item,
    previousCandidate: cloneCandidate(item.candidate),
    previousStoredReview: reviewState.candidates[key],
  });

  const stored = setCandidateDecision(item.word, item.candidate, status, accent, notes);

  reviewState = upsertStoredReview(reviewState, stored);

  await writeJson(options.report, report);
  await saveReviewState(reviewState, options.reviewStatePath);
  await updateMetadataFile(item.candidate);
}

async function undoLastDecision(): Promise<ReviewItem | null> {
  const previous = decisionHistory.pop();

  if (!previous) {
    console.log("Nothing to undo.");
    return null;
  }

  const key = createCandidateKey({
    wordId: previous.item.word.wordId,
    fileTitle: previous.item.candidate.fileTitle,
    commonsUrl: previous.item.candidate.commonsUrl,
  });

  Object.keys(previous.item.candidate).forEach((candidateKey) => {
    delete previous.item.candidate[candidateKey as keyof ReviewableCandidate];
  });
  Object.assign(previous.item.candidate, previous.previousCandidate);

  if (previous.previousStoredReview) {
    reviewState = upsertStoredReview(reviewState, previous.previousStoredReview);
  } else {
    const nextCandidates = { ...reviewState.candidates };
    delete nextCandidates[key];
    reviewState = {
      ...reviewState,
      updatedAt: new Date().toISOString(),
      candidates: nextCandidates,
    };
  }

  await writeJson(options.report, report);
  await saveReviewState(reviewState, options.reviewStatePath);
  await updateMetadataFile(previous.item.candidate);
  console.log("Undid last decision.");

  return previous.item;
}

function setCandidateDecision(
  word: ReviewedWord,
  candidate: CandidateWithIdentity,
  status: AudioReviewStatus,
  accent: string | undefined,
  notes: string | undefined,
): StoredCandidateReview {
  candidate.key = candidate.key ?? createCandidateKey({
    wordId: word.wordId,
    fileTitle: candidate.fileTitle,
    commonsUrl: candidate.commonsUrl,
  });

  if (candidate.localPath && !candidate.datasetSrc) {
    candidate.datasetSrc = toDatasetAudioSrc(candidate.localPath);
  }

  if (candidate.datasetSrc) {
    candidate.suggestedAudioSource = createAudioSource(candidate, candidate.datasetSrc, accent, notes);
  }

  candidate.review = compactReview({ status, accent, notes });

  return {
    key: candidate.key,
    wordId: word.wordId,
    written: word.written,
    fileTitle: candidate.fileTitle,
    commonsUrl: candidate.commonsUrl,
    localPath: candidate.localPath,
    metadataPath: candidate.metadataPath,
    datasetSrc: candidate.datasetSrc,
    suggestedAudioSource: candidate.suggestedAudioSource,
    status,
    accent,
    notes,
    reviewedAt: new Date().toISOString(),
  };
}

function createAudioSource(
  candidate: CandidateWithIdentity,
  datasetSrc: string,
  accent: string | undefined,
  notes: string | undefined,
): AudioSource {
  const suggested = candidate.suggestedAudioSource;

  return compactAudioSource({
    src: datasetSrc,
    kind: suggested?.kind ?? "wiktionary",
    speaker: suggested?.speaker,
    accent: accent ?? candidate.regions?.[0] ?? suggested?.accent,
    license: suggested?.license ?? candidate.licenseShortName ?? candidate.license ?? undefined,
    attribution: suggested?.attribution ?? candidate.attribution ?? candidate.artist ?? candidate.credit ?? undefined,
    sourceUrl: suggested?.sourceUrl ?? candidate.commonsUrl,
    notes: notes ?? suggested?.notes,
  });
}

function compactReview(review: {
  status: AudioReviewStatus;
  accent?: string;
  notes?: string;
}): { status: AudioReviewStatus; accent?: string; notes?: string } {
  return Object.fromEntries(
    Object.entries(review).filter(([, value]) => value !== undefined && value !== ""),
  ) as { status: AudioReviewStatus; accent?: string; notes?: string };
}

function compactAudioSource(source: AudioSource): AudioSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  ) as AudioSource;
}

function cloneCandidate(candidate: ReviewableCandidate): ReviewableCandidate {
  return JSON.parse(JSON.stringify(candidate)) as ReviewableCandidate;
}

async function updateMetadataFile(candidate: ReviewableCandidate): Promise<void> {
  if (!candidate.metadataPath) {
    return;
  }

  try {
    const metadata = JSON.parse(await readFile(candidate.metadataPath, "utf8")) as unknown;

    if (!isRecord(metadata)) {
      return;
    }

    const existingCandidate = isRecord(metadata.candidate) ? metadata.candidate : {};

    await writeJson(candidate.metadataPath, {
      ...metadata,
      candidate: {
        ...existingCandidate,
        key: candidate.key,
        localPath: candidate.localPath,
        metadataPath: candidate.metadataPath,
        datasetSrc: candidate.datasetSrc,
        suggestedAudioSource: candidate.suggestedAudioSource,
        review: candidate.review,
      },
    });
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function applyStoredReviewsToReport(report: ReviewedReport, state: AudioReviewState): boolean {
  let changed = false;

  for (const word of report.words ?? []) {
    for (const candidate of word.candidates ?? []) {
      if (!hasCandidateIdentity(candidate)) {
        continue;
      }

      const stored = getStoredReview(state, {
        wordId: word.wordId,
        fileTitle: candidate.fileTitle,
        commonsUrl: candidate.commonsUrl,
      });

      if (!stored) {
        continue;
      }

      candidate.key = stored.key;
      candidate.localPath = stored.localPath ?? candidate.localPath;
      candidate.metadataPath = stored.metadataPath ?? candidate.metadataPath;
      candidate.datasetSrc = stored.datasetSrc ?? candidate.datasetSrc;
      candidate.suggestedAudioSource = stored.suggestedAudioSource ?? candidate.suggestedAudioSource;
      candidate.review = {
        status: stored.status,
        accent: stored.accent ?? candidate.review?.accent,
        notes: stored.notes ?? candidate.review?.notes,
      };
      changed = true;
    }
  }

  return changed;
}

function syncReportReviewsToState(
  report: ReviewedReport,
  state: AudioReviewState,
): { state: AudioReviewState; changed: boolean } {
  let nextState = state;
  let changed = false;

  for (const word of report.words ?? []) {
    for (const candidate of word.candidates ?? []) {
      if (!hasCandidateIdentity(candidate)) {
        continue;
      }

      const status = parseReviewStatus(candidate.review?.status);

      if (status !== "approved" && status !== "rejected") {
        continue;
      }

      const stored = setCandidateDecision(
        word,
        candidate,
        status,
        candidate.review?.accent,
        candidate.review?.notes,
      );

      nextState = upsertStoredReview(nextState, stored);
      changed = true;
    }
  }

  return { state: nextState, changed };
}

function getReviewItems(report: ReviewedReport, opts: CliOptions): ReviewItem[] {
  const requestedWords = new Set(opts.words.map(normalizeSearchText));
  const items: ReviewItem[] = [];

  for (const word of report.words ?? []) {
    if (requestedWords.size > 0 && !requestedWords.has(normalizeSearchText(word.wordId)) && !requestedWords.has(normalizeSearchText(word.written))) {
      continue;
    }

    for (const candidate of word.candidates ?? []) {
      if (!isReviewableCandidate(candidate)) {
        continue;
      }

      const status = parseReviewStatus(candidate.review?.status) ?? "pending";

      if (!opts.includeReviewed && status !== "pending") {
        continue;
      }

      items.push({ word, candidate });
    }
  }

  return opts.limit === null ? items : items.slice(0, opts.limit);
}

function printCandidate(item: ReviewItem, index: number, total: number): void {
  const { word, candidate } = item;

  console.log("");
  console.log(`[${index}/${total}] ${word.written}${word.ipa ? ` ${word.ipa}` : ""}`);
  console.log(`File: ${candidate.fileTitle}`);
  console.log(`Local path: ${candidate.localPath}`);
  console.log(`Source: ${candidate.commonsUrl}`);
  console.log(`License: ${candidate.licenseShortName ?? candidate.license ?? "unknown"}`);
  console.log(`Attribution: ${candidate.attribution ?? candidate.artist ?? candidate.credit ?? "unknown"}`);
  console.log(`Regions: ${candidate.regions?.length ? candidate.regions.join(", ") : "none detected"}`);
  console.log(`IPA check: ${formatCandidateIpaCheck(candidate)}`);

  if (candidate.score !== undefined) {
    console.log(`Score: ${candidate.score}${candidate.reasons?.length ? ` (${candidate.reasons.join("; ")})` : ""}`);
  }
}

function formatCandidateIpaCheck(candidate: ReviewedCandidate): string {
  const check = candidate.ipaCheck;

  if (!check || check.status === "unknown") {
    return `unknown${check?.expected ? `; expected ${check.expected}` : ""}`;
  }

  return `${check.status}; expected ${check.expected ?? "unknown"}; Wiktionary claimed ${check.claimed?.join(", ") || "unknown"}`;
}

async function playCandidate(player: PlayerSpec, localPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(player.command, [...player.args, path.resolve(localPath)], { stdio: "inherit" });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM" || signal === "SIGINT") {
        resolve();
        return;
      }

      reject(new Error(`${player.command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function resolvePlayer(playerArg: string | null): PlayerSpec | null {
  if (playerArg) {
    return parsePlayerSpec(playerArg);
  }

  const candidates: PlayerSpec[] = [
    { command: "mpv", args: ["--really-quiet", "--no-video"] },
    { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error"] },
    { command: "play", args: [] },
  ];

  return candidates.find((candidate) => commandExists(candidate.command)) ?? null;
}

function parsePlayerSpec(value: string): PlayerSpec {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const command = parts[0];

  if (!command) {
    throw new Error("--player requires a command.");
  }

  return { command, args: parts.slice(1) };
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasCandidateIdentity(candidate: ReviewedCandidate): candidate is CandidateWithIdentity {
  return Boolean(candidate.fileTitle && candidate.commonsUrl);
}

function isReviewableCandidate(candidate: ReviewedCandidate): candidate is ReviewableCandidate {
  return Boolean(candidate.fileTitle && candidate.commonsUrl && candidate.localPath);
}

function parseReviewStatus(value: string | undefined): AudioReviewStatus | null {
  if (value === "pending" || value === "approved" || value === "rejected") {
    return value;
  }

  return null;
}

function meaningfulNotes(notes: string | undefined): string | undefined {
  if (!notes || notes.startsWith("Listen before approving")) {
    return undefined;
  }

  return notes;
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
    report: getLast(values, "report") ?? defaults.report,
    reviewStatePath: getLast(values, "review-state") ?? defaults.reviewState,
    player: getLast(values, "player") ?? null,
    play: !values.has("no-play"),
    autoplay: !values.has("no-autoplay") && !values.has("no-play"),
    includeReviewed: values.has("include-reviewed"),
    words: splitList([...(values.get("word") ?? []), ...(values.get("words") ?? [])]),
    limit: parseOptionalInteger(getLast(values, "limit")),
  };
}

function printUsage(): void {
  console.log("Usage: bun run audio:review -- [options]");
  console.log("Options: --language=en-GB --words=ship,sheep --limit=10 --include-reviewed --player=mpv --no-autoplay --no-play");
}

function getLanguagePathDefaults(languageId: string): { report: string; reviewState: string } {
  const slug = getLanguageSlug(languageId);
  const reportPrefix = sameLanguageId(languageId, "fr") ? "wiktionary" : `${slug}-wiktionary`;

  return {
    report: `reports/${reportPrefix}-audio-candidates.json`,
    reviewState: sameLanguageId(languageId, "fr")
      ? DEFAULT_REVIEW_STATE_PATH
      : `reports/${slug}-wiktionary-audio-review-state.json`,
  };
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

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
