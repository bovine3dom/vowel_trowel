import {
  LAST_LANGUAGE_STORAGE_KEY,
  resolveLanguageId,
} from "./metadata";
import type { LanguageDataset, LanguageId } from "./types";

const DEFAULT_LANGUAGE_ID = "fr";

export async function loadLanguageDataset(languageId: LanguageId | undefined | null): Promise<LanguageDataset> {
  switch (resolveLanguageId(languageId) ?? DEFAULT_LANGUAGE_ID) {
    case "en-GB":
      return (await import("./en-gb")).britishEnglishDataset;
    case "fr":
    default:
      return (await import("./fr")).frenchDataset;
  }
}

export function readInitialLanguageId(): LanguageId {
  if (typeof window === "undefined") {
    return DEFAULT_LANGUAGE_ID;
  }

  const params = new URLSearchParams(window.location.search);
  const urlLanguageId = resolveLanguageId(params.get("l") ?? params.get("lang"));
  const storedLanguageId = resolveLanguageId(window.localStorage.getItem(LAST_LANGUAGE_STORAGE_KEY));

  return urlLanguageId ?? storedLanguageId ?? DEFAULT_LANGUAGE_ID;
}
