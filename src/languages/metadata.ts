import type { LanguageDataset, LanguageId } from "./types";

export const LAST_LANGUAGE_STORAGE_KEY = "vowel-trowel:last-language";

export const languageOptions = [
  { id: "fr", name: "French", autonym: "français" },
  { id: "en-GB", name: "British English", autonym: "British English" },
] as const satisfies readonly Pick<LanguageDataset, "id" | "name" | "autonym">[];

export function resolveLanguageId(languageId: LanguageId | undefined | null): LanguageId | null {
  return languageOptions.find((language) => sameLanguageId(language.id, languageId ?? undefined))?.id ?? null;
}

export function getLanguageSlug(languageId: LanguageId): string {
  return languageId.toLowerCase();
}

export function sameLanguageId(left: LanguageId | undefined, right: LanguageId | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}
