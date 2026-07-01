import type { MinimalPairTerm } from "../languages/types";

export function lockTermAudio(term: MinimalPairTerm): MinimalPairTerm {
  const selectedAudio = pickOne(term.word.audio);

  return selectedAudio ? { ...term, selectedAudio } : term;
}

function pickOne<T>(items: readonly T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }

  return items[Math.floor(Math.random() * items.length)];
}
