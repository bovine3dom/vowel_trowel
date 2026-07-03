import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
  source: AudioCandidateSource;
  report: string;
  reviewStatePath: string;
  player: string | null;
  play: boolean;
  autoplay: boolean;
  includeReviewed: boolean;
  words: string[];
  limit: number | null;
}

type AudioCandidateSource = "wiktionary" | "mswc" | "contribution";
type AudioCleanupFilterId = "volume" | "noise" | "click" | "crop";

interface CandidateAudioPointer {
  localPath: string;
  metadataPath?: string;
  datasetSrc?: string;
  suggestedAudioSource?: AudioSource;
}

interface AudioProcessingStep {
  filter: AudioCleanupFilterId;
  label: string;
  tool: string;
  command: string;
  inputPath: string;
  outputPath: string;
  datasetSrc: string;
  metadataPath: string;
  appliedAt: string;
}

interface AudioProcessingState {
  original: CandidateAudioPointer;
  history: AudioProcessingStep[];
  currentStep: number;
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
  sourceId?: string;
  sourceName?: string;
  sourceUrl?: string;
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
  targetPhonemeIds?: string[];
  targetContrasts?: string[];
  graphemeCheck?: {
    status?: string;
    notes?: string[];
  };
  accentPolicy?: {
    status?: string;
    notes?: string[];
  };
  suggestedAudioSource?: AudioSource;
  audioProcessing?: AudioProcessingState;
  review?: {
    status?: string;
    accent?: string;
    notes?: string;
  };
}

interface CandidateWithIdentity extends ReviewedCandidate {
  fileTitle: string;
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
let pipedCommandBuffer: string[] | null = null;
const cleanupTools = {
  sox: commandExists("sox"),
  ffmpeg: commandExists("ffmpeg"),
};

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

const rl = input.isTTY ? createInterface({ input, output }) : null;

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
  rl?.close();
}

async function reviewItem(
  item: ReviewItem,
  index: number,
  total: number,
  rl: Interface | null,
  player: PlayerSpec | null,
  opts: CliOptions,
): Promise<ReviewOutcome> {
  printCandidate(item, index, total);

  if (player && opts.autoplay) {
    await playCandidate(player, item.candidate.localPath);
  }

  while (true) {
    const command = await readCommandKey(
      rl,
      "Choice [a]pprove [r]eject [s]kip [w]ord [p]lay [u]ndo decision [q]uit | filters [v]olume [n]oise [k]lick [c]rop [z]undo [y]redo: ",
    );

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

    if (command === "v") {
      await applyCleanupFilter(item, "volume", player);
      continue;
    }

    if (command === "n") {
      await applyCleanupFilter(item, "noise", player);
      continue;
    }

    if (command === "k") {
      await applyCleanupFilter(item, "click", player);
      continue;
    }

    if (command === "c") {
      await applyCleanupFilter(item, "crop", player);
      continue;
    }

    if (command === "z") {
      await moveCleanupHistory(item, -1, player);
      continue;
    }

    if (command === "y") {
      await moveCleanupHistory(item, 1, player);
      continue;
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

    console.log("Unknown choice. Use a, r, s, w, p, u, q, v, n, k, c, z, or y.");
  }
}

async function readCommandKey(rl: Interface | null, prompt: string): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function" || !rl) {
    pipedCommandBuffer ??= await readPipedCommands();
    const command = pipedCommandBuffer.shift() ?? "q";

    output.write(`${prompt}${command}\n`);
    return command;
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

async function readPipedCommands(): Promise<string[]> {
  const chunks: Buffer[] = [];

  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase()[0] ?? "")
    .filter(Boolean);
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
  const key = createCandidateKey(getCandidateIdentity(item.word, item.candidate));

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

  const key = createCandidateKey(getCandidateIdentity(previous.item.word, previous.item.candidate));

  restoreCandidate(previous.item.candidate, previous.previousCandidate);

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

async function applyCleanupFilter(
  item: ReviewItem,
  filterId: AudioCleanupFilterId,
  player: PlayerSpec | null,
): Promise<void> {
  const filter = getCleanupFilter(filterId);

  if (!filter) {
    console.log(`Unknown audio filter ${filterId}.`);
    return;
  }

  if (!isCleanupFilterAvailable(filterId)) {
    console.log(`${filter.label} requires ${requiredCleanupTool(filterId)}.`);
    return;
  }

  const state = getAudioProcessingState(item.candidate);
  const retainedHistory = state.history.slice(0, state.currentStep + 1);
  const outputPath = createProcessedAudioPath(state.original.localPath, filterId, retainedHistory.length + 1);
  const metadataPath = `${outputPath}.metadata.json`;
  const previousCandidate = cloneCandidate(item.candidate);

  try {
    await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    const command = await runCleanupFilter(filterId, item.candidate.localPath, outputPath);
    const step: AudioProcessingStep = {
      filter: filterId,
      label: filter.label,
      tool: requiredCleanupTool(filterId),
      command,
      inputPath: item.candidate.localPath,
      outputPath,
      datasetSrc: toDatasetAudioSrc(outputPath),
      metadataPath,
      appliedAt: new Date().toISOString(),
    };

    item.candidate.audioProcessing = {
      original: state.original,
      history: [...retainedHistory, step],
      currentStep: retainedHistory.length,
    };
    setCandidateAudioPointer(item.candidate, pointerFromStep(step));

    await persistAudioEdit(item);
    console.log(`Applied ${filter.label}. Current file: ${item.candidate.localPath}`);
  } catch (error) {
    restoreCandidate(item.candidate, previousCandidate);
    await rm(outputPath, { force: true }).catch(() => undefined);
    console.log(`Could not apply ${filter.label}: ${formatErrorMessage(error)}`);
    return;
  }

  await playAfterAudioEdit(player, item.candidate.localPath);
}

async function moveCleanupHistory(
  item: ReviewItem,
  direction: -1 | 1,
  player: PlayerSpec | null,
): Promise<void> {
  const state = getAudioProcessingState(item.candidate);
  const nextStep = state.currentStep + direction;

  if (nextStep < -1) {
    console.log("No audio filter change to undo.");
    return;
  }

  if (nextStep >= state.history.length) {
    console.log("No audio filter change to redo.");
    return;
  }

  item.candidate.audioProcessing = {
    ...state,
    currentStep: nextStep,
  };
  setCandidateAudioPointer(
    item.candidate,
    nextStep >= 0 ? pointerFromStep(state.history[nextStep] as AudioProcessingStep) : state.original,
  );

  await persistAudioEdit(item);
  console.log(`${direction < 0 ? "Undid" : "Redid"} audio filter change. Current file: ${item.candidate.localPath}`);
  await playAfterAudioEdit(player, item.candidate.localPath);
}

async function persistAudioEdit(item: ReviewItem): Promise<void> {
  await writeJson(options.report, report);
  await updateMetadataFile(item.candidate);
}

async function playAfterAudioEdit(player: PlayerSpec | null, localPath: string): Promise<void> {
  if (!player) {
    return;
  }

  try {
    await playCandidate(player, localPath);
  } catch (error) {
    console.log(`Could not play edited audio: ${formatErrorMessage(error)}`);
  }
}

function restoreCandidate(candidate: ReviewableCandidate, previous: ReviewableCandidate): void {
  Object.keys(candidate).forEach((candidateKey) => {
    delete candidate[candidateKey as keyof ReviewableCandidate];
  });
  Object.assign(candidate, previous);
}

function getCleanupFilter(filterId: AudioCleanupFilterId): { label: string } | null {
  switch (filterId) {
    case "volume":
      return { label: "volume normalization" };
    case "noise":
      return { label: "background noise reduction" };
    case "click":
      return { label: "click removal" };
    case "crop":
      return { label: "automatic cropping" };
  }
}

function isCleanupFilterAvailable(filterId: AudioCleanupFilterId): boolean {
  return requiredCleanupTool(filterId) === "sox" ? cleanupTools.sox : cleanupTools.ffmpeg;
}

function requiredCleanupTool(filterId: AudioCleanupFilterId): "sox" | "ffmpeg" {
  return filterId === "click" ? "ffmpeg" : "sox";
}

async function runCleanupFilter(
  filterId: AudioCleanupFilterId,
  inputPath: string,
  outputPath: string,
): Promise<string> {
  switch (filterId) {
    case "volume":
      return runAudioCommand("sox", ["-G", path.resolve(inputPath), path.resolve(outputPath), "norm", "-3"]);
    case "crop":
      return runAudioCommand("sox", [
        "-G",
        path.resolve(inputPath),
        path.resolve(outputPath),
        "silence",
        "1",
        "0.05",
        "-45d",
        "reverse",
        "silence",
        "1",
        "0.10",
        "-45d",
        "reverse",
        "pad",
        "0.06",
        "0.08",
      ]);
    case "noise":
      return await runNoiseReduction(inputPath, outputPath);
    case "click":
      return runAudioCommand("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.resolve(inputPath),
        "-vn",
        "-af",
        "adeclick",
        "-c:a",
        "libvorbis",
        "-q:a",
        "5",
        path.resolve(outputPath),
      ]);
  }
}

async function runNoiseReduction(inputPath: string, outputPath: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "vowel-trowel-noise-"));
  const profilePath = path.join(tempDir, "noise.prof");

  try {
    const profileCommand = runAudioCommand("sox", [
      path.resolve(inputPath),
      "-n",
      "trim",
      "0",
      "0.25",
      "noiseprof",
      profilePath,
    ]);
    const reduceCommand = runAudioCommand("sox", [
      "-G",
      path.resolve(inputPath),
      path.resolve(outputPath),
      "highpass",
      "80",
      "noisered",
      profilePath,
      "0.12",
    ]);

    return `${profileCommand} && ${reduceCommand}`;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runAudioCommand(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}${details ? `: ${details}` : ""}`);
  }

  return formatCommand(command, args);
}

function formatCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(formatCommandPart).join(" ");
}

function formatCommandPart(value: string): string {
  return /^[a-zA-Z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function createProcessedAudioPath(originalPath: string, filterId: AudioCleanupFilterId, stepNumber: number): string {
  const parsed = path.parse(originalPath);
  const paddedStep = stepNumber.toString().padStart(2, "0");

  return path.join(parsed.dir, `${parsed.name}--clean-${paddedStep}-${filterId}.ogg`);
}

function getAudioProcessingState(candidate: ReviewableCandidate): AudioProcessingState {
  const existing = candidate.audioProcessing;
  const history = existing?.history ?? [];
  const currentStep = existing && Number.isInteger(existing.currentStep)
    ? Math.max(-1, Math.min(existing.currentStep, history.length - 1))
    : history.length - 1;

  return {
    original: existing?.original ?? {
      localPath: candidate.localPath,
      metadataPath: candidate.metadataPath,
      datasetSrc: candidate.datasetSrc,
      suggestedAudioSource: candidate.suggestedAudioSource,
    },
    history,
    currentStep,
  };
}

function pointerFromStep(step: AudioProcessingStep): CandidateAudioPointer {
  return {
    localPath: step.outputPath,
    metadataPath: step.metadataPath,
    datasetSrc: step.datasetSrc,
  };
}

function setCandidateAudioPointer(candidate: ReviewableCandidate, pointer: CandidateAudioPointer): void {
  candidate.localPath = pointer.localPath;
  candidate.metadataPath = pointer.metadataPath ?? `${pointer.localPath}.metadata.json`;
  candidate.datasetSrc = pointer.datasetSrc ?? toDatasetAudioSrc(pointer.localPath);
  candidate.suggestedAudioSource = pointer.suggestedAudioSource
    ? { ...pointer.suggestedAudioSource, src: candidate.datasetSrc }
    : compactAudioSource({
      ...(candidate.suggestedAudioSource ?? createAudioSource(
        candidate,
        candidate.datasetSrc,
        candidate.review?.accent,
        meaningfulNotes(candidate.review?.notes),
      )),
      src: candidate.datasetSrc,
    });
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    sourceId: candidate.sourceId,
    sourceUrl: candidate.sourceUrl,
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
    sourceId: candidate.sourceId,
    sourceName: candidate.sourceName,
    sourceUrl: candidate.sourceUrl,
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
    kind: suggested?.kind ?? (candidate.sourceId?.startsWith("mswc:") ? "external" : "wiktionary"),
    speaker: suggested?.speaker,
    accent: accent ?? candidate.regions?.[0] ?? suggested?.accent,
    license: suggested?.license ?? candidate.licenseShortName ?? candidate.license ?? undefined,
    attribution: suggested?.attribution ?? candidate.attribution ?? candidate.artist ?? candidate.credit ?? undefined,
    sourceUrl: suggested?.sourceUrl ?? candidate.sourceUrl ?? candidate.commonsUrl,
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

  let metadata: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(await readFile(candidate.metadataPath, "utf8")) as unknown;

    if (!isRecord(parsed)) {
      return;
    }

    metadata = parsed;
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const existingCandidate = isRecord(metadata.candidate) ? metadata.candidate : {};

  await writeJson(candidate.metadataPath, {
    ...metadata,
    updatedAt: new Date().toISOString(),
    candidate: {
      ...existingCandidate,
      key: candidate.key,
      localPath: candidate.localPath,
      metadataPath: candidate.metadataPath,
      datasetSrc: candidate.datasetSrc,
      suggestedAudioSource: candidate.suggestedAudioSource,
      audioProcessing: candidate.audioProcessing,
      review: candidate.review,
    },
  });
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
        sourceId: candidate.sourceId,
        sourceUrl: candidate.sourceUrl,
        commonsUrl: candidate.commonsUrl,
      });

      if (!stored) {
        continue;
      }

      candidate.key = stored.key;
      candidate.sourceId = stored.sourceId ?? candidate.sourceId;
      candidate.sourceName = stored.sourceName ?? candidate.sourceName;
      candidate.sourceUrl = stored.sourceUrl ?? candidate.sourceUrl;
      candidate.commonsUrl = stored.commonsUrl ?? candidate.commonsUrl;
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
  console.log(`Source: ${candidate.sourceName ? `${candidate.sourceName} ` : ""}${candidate.sourceUrl ?? candidate.commonsUrl ?? candidate.sourceId ?? "unknown"}`);
  console.log(`Licence: ${candidate.licenseShortName ?? candidate.license ?? "unknown"}`);
  console.log(`Attribution: ${candidate.attribution ?? candidate.artist ?? candidate.credit ?? "unknown"}`);
  console.log(`Regions: ${candidate.regions?.length ? candidate.regions.join(", ") : "none detected"}`);
  console.log(`Target phonemes: ${candidate.targetPhonemeIds?.length ? candidate.targetPhonemeIds.join(", ") : word.phonemeIds?.join(", ") ?? "unknown"}`);
  console.log(`Processing: ${formatAudioProcessing(candidate)}`);
  console.log(`IPA check: ${formatCandidateIpaCheck(candidate)}`);

  if (candidate.graphemeCheck) {
    console.log(`Grapheme check: ${formatSafetyCheck(candidate.graphemeCheck)}`);
  }

  if (candidate.accentPolicy) {
    console.log(`Accent policy: ${formatSafetyCheck(candidate.accentPolicy)}`);
  }

  if (candidate.score !== undefined) {
    console.log(`Score: ${candidate.score}${candidate.reasons?.length ? ` (${candidate.reasons.join("; ")})` : ""}`);
  }
}

function formatAudioProcessing(candidate: ReviewedCandidate): string {
  const state = candidate.audioProcessing;

  if (!state?.history.length) {
    return "original";
  }

  const currentStep = Math.max(-1, Math.min(state.currentStep, state.history.length - 1));
  const applied = currentStep >= 0
    ? state.history.slice(0, currentStep + 1).map((step) => step.label).join(" -> ")
    : "original";
  const redoCount = state.history.length - currentStep - 1;

  return redoCount > 0 ? `${applied}; ${redoCount} redo step${redoCount === 1 ? "" : "s"} available` : applied;
}

function formatCandidateIpaCheck(candidate: ReviewedCandidate): string {
  const check = candidate.ipaCheck;

  if (!check || check.status === "unknown") {
    return `unknown${check?.expected ? `; expected ${check.expected}` : ""}`;
  }

  return `${check.status}; expected ${check.expected ?? "unknown"}; Wiktionary claimed ${check.claimed?.join(", ") || "unknown"}`;
}

function formatSafetyCheck(check: { status?: string; notes?: string[] }): string {
  return `${check.status ?? "unknown"}${check.notes?.length ? `; ${check.notes.join("; ")}` : ""}`;
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
  return Boolean(candidate.fileTitle && getCandidateSourceKey(candidate));
}

function isReviewableCandidate(candidate: ReviewedCandidate): candidate is ReviewableCandidate {
  return Boolean(candidate.fileTitle && getCandidateSourceKey(candidate) && candidate.localPath);
}

function getCandidateIdentity(word: ReviewedWord, candidate: CandidateWithIdentity): {
  wordId: string;
  fileTitle: string;
  sourceId?: string;
  sourceUrl?: string;
  commonsUrl?: string;
} {
  return {
    wordId: word.wordId,
    fileTitle: candidate.fileTitle,
    sourceId: candidate.sourceId,
    sourceUrl: candidate.sourceUrl,
    commonsUrl: candidate.commonsUrl,
  };
}

function getCandidateSourceKey(candidate: ReviewedCandidate): string | undefined {
  return candidate.sourceId ?? candidate.sourceUrl ?? candidate.commonsUrl;
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
  const source = parseSource(getLast(values, "source"));
  const defaults = getLanguagePathDefaults(languageId, source);

  return {
    languageId,
    source,
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
  console.log("Options: --source=wiktionary|mswc|contribution --language=en-GB --words=ship,sheep --limit=10 --include-reviewed --player=mpv --no-autoplay --no-play");
  console.log("During review: v=normalize volume, n=reduce noise, k=remove clicks, c=crop silence, z/y=undo/redo audio filters.");
}

function getLanguagePathDefaults(languageId: string, source: AudioCandidateSource): { report: string; reviewState: string } {
  const slug = getLanguageSlug(languageId);
  const reportPrefix = getReportPrefix(languageId, source);

  return {
    report: `reports/${reportPrefix}-audio-candidates.json`,
    reviewState: source === "wiktionary" && sameLanguageId(languageId, "fr")
      ? DEFAULT_REVIEW_STATE_PATH
      : `reports/${slug}-${source}-audio-review-state.json`,
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

  if (value === "mswc") {
    return "mswc";
  }

  if (value === "contribution") {
    return "contribution";
  }

  throw new Error(`Expected --source=wiktionary, --source=mswc, or --source=contribution; got ${value}.`);
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
