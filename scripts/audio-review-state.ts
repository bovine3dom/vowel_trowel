import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { AudioSource } from "../src/languages/types";

export const DEFAULT_REVIEW_STATE_PATH = "reports/wiktionary-audio-review-state.json";

export type AudioReviewStatus = "pending" | "approved" | "rejected";

export interface CandidateReview {
  status: AudioReviewStatus;
  accent?: string;
  notes?: string;
}

export interface StoredCandidateReview extends CandidateReview {
  key: string;
  wordId: string;
  written: string;
  fileTitle: string;
  commonsUrl: string;
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
  suggestedAudioSource?: AudioSource;
  reviewedAt: string;
}

export interface AudioReviewState {
  version: 1;
  updatedAt: string;
  candidates: Record<string, StoredCandidateReview>;
}

export interface CandidateIdentity {
  wordId: string;
  fileTitle: string;
  commonsUrl: string;
}

export function createEmptyReviewState(): AudioReviewState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    candidates: {},
  };
}

export async function loadReviewState(filePath = DEFAULT_REVIEW_STATE_PATH): Promise<AudioReviewState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<AudioReviewState>;

    if (parsed.version !== 1 || !parsed.candidates) {
      return createEmptyReviewState();
    }

    return parsed as AudioReviewState;
  } catch (error) {
    if (isMissingFileError(error)) {
      return createEmptyReviewState();
    }

    throw error;
  }
}

export async function saveReviewState(
  state: AudioReviewState,
  filePath = DEFAULT_REVIEW_STATE_PATH,
): Promise<void> {
  const nextState = { ...state, updatedAt: new Date().toISOString() };

  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(nextState, null, 2)}\n`);
}

export function getStoredReview(
  state: AudioReviewState,
  identity: CandidateIdentity,
): StoredCandidateReview | undefined {
  return state.candidates[createCandidateKey(identity)];
}

export function upsertStoredReview(
  state: AudioReviewState,
  review: StoredCandidateReview,
): AudioReviewState {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    candidates: {
      ...state.candidates,
      [review.key]: review,
    },
  };
}

export function createCandidateKey(identity: CandidateIdentity): string {
  return [identity.wordId, identity.fileTitle, identity.commonsUrl]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
