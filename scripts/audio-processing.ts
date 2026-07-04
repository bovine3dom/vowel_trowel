import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { AudioSource } from "../src/languages/types";

export type AudioCleanupFilterId = "volume" | "noise" | "click" | "crop";

export interface CandidateAudioPointer {
  localPath: string;
  metadataPath?: string;
  datasetSrc?: string;
  suggestedAudioSource?: AudioSource;
}

export interface AudioProcessingStep {
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

export interface AudioProcessingState {
  original: CandidateAudioPointer;
  history: AudioProcessingStep[];
  currentStep: number;
}

export function createDefaultVolumeProcessingState(
  candidate: { suggestedAudioSource?: AudioSource },
  original: CandidateAudioPointer,
  normalized: CandidateAudioPointer & { command: string },
): AudioProcessingState {
  const originalDatasetSrc = original.datasetSrc ?? toDatasetAudioSrc(original.localPath);
  const normalizedDatasetSrc = normalized.datasetSrc ?? toDatasetAudioSrc(normalized.localPath);
  const originalSuggestedAudioSource = original.suggestedAudioSource ?? (candidate.suggestedAudioSource
    ? {
      ...candidate.suggestedAudioSource,
      src: originalDatasetSrc,
    }
    : undefined);

  return {
    original: {
      localPath: original.localPath,
      metadataPath: original.metadataPath ?? `${original.localPath}.metadata.json`,
      datasetSrc: originalDatasetSrc,
      suggestedAudioSource: originalSuggestedAudioSource,
    },
    history: [{
      filter: "volume",
      label: "volume normalization",
      tool: "sox",
      command: normalized.command,
      inputPath: original.localPath,
      outputPath: normalized.localPath,
      datasetSrc: normalizedDatasetSrc,
      metadataPath: normalized.metadataPath ?? `${normalized.localPath}.metadata.json`,
      appliedAt: new Date().toISOString(),
    }],
    currentStep: 0,
  };
}

export function createOriginalCandidateSnapshot<T extends {
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
  suggestedAudioSource?: AudioSource;
  audioProcessing?: AudioProcessingState;
}>(candidate: T, original: CandidateAudioPointer): T {
  const datasetSrc = original.datasetSrc ?? toDatasetAudioSrc(original.localPath);
  const suggestedAudioSource = original.suggestedAudioSource ?? (candidate.suggestedAudioSource
    ? {
      ...candidate.suggestedAudioSource,
      src: datasetSrc,
    }
    : undefined);

  return {
    ...candidate,
    localPath: original.localPath,
    metadataPath: original.metadataPath ?? `${original.localPath}.metadata.json`,
    datasetSrc,
    suggestedAudioSource,
    audioProcessing: undefined,
  } as T;
}

export function createProcessedAudioPath(originalPath: string, filterId: AudioCleanupFilterId, stepNumber: number): string {
  const parsed = path.parse(originalPath);
  const paddedStep = stepNumber.toString().padStart(2, "0");

  return path.join(parsed.dir, `${parsed.name}--clean-${paddedStep}-${filterId}.ogg`);
}

export function runVolumeNormalization(inputPath: string, outputPath: string): string {
  return runAudioCommand("sox", volumeNormalizationArgs(inputPath, outputPath));
}

export function formatVolumeNormalizationCommand(inputPath: string, outputPath: string): string {
  return formatCommand("sox", volumeNormalizationArgs(inputPath, outputPath));
}

export function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

function volumeNormalizationArgs(inputPath: string, outputPath: string): string[] {
  return ["-G", path.resolve(inputPath), path.resolve(outputPath), "norm", "-3"];
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
