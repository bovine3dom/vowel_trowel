import { britishEnglishDataset } from "./en-gb";
import { frenchDataset } from "./fr";
import type { LanguageDataset, LanguageId } from "./types";

export const languageDatasets = [frenchDataset, britishEnglishDataset] as const satisfies readonly LanguageDataset[];

export function getLanguageDataset(languageId: LanguageId | undefined): LanguageDataset {
  return languageDatasets.find((dataset) => sameLanguageId(dataset.id, languageId)) ?? frenchDataset;
}

export function getLanguageSlug(languageId: LanguageId): string {
  return languageId.toLowerCase();
}

export function sameLanguageId(left: LanguageId | undefined, right: LanguageId | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}
