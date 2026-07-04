/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import { createContributionQueue, contributionWordIdsForSpeaker } from "../../src/contributions/queue";
import type { LanguageDataset } from "../../src/languages/types";

const testDataset = {
  id: "test",
  name: "Test",
  autonym: "Test",
  defaultSpeechLang: "und",
  phonemes: [
    { id: "test-a", ipa: "a", label: "a", category: "vowel" },
  ],
  contrasts: [],
  words: [
    {
      id: "test-word-speaker",
      written: "speaker",
      ipa: "/a/",
      phonemeIds: ["test-a"],
      audio: [
        { src: "speaker.ogg", kind: "contribution", speaker: "Alice" },
      ],
    },
    {
      id: "test-word-attribution",
      written: "attribution",
      ipa: "/a/",
      phonemeIds: ["test-a"],
      audio: [
        { src: "attribution.ogg", kind: "contribution", attribution: "ALICE" },
      ],
    },
    {
      id: "test-word-wiktionary",
      written: "wiktionary",
      ipa: "/a/",
      phonemeIds: ["test-a"],
      audio: [
        { src: "wiktionary.ogg", kind: "wiktionary", attribution: "Alice" },
      ],
    },
    {
      id: "test-word-external",
      written: "external",
      ipa: "/a/",
      phonemeIds: ["test-a"],
      audio: [
        { src: "external.ogg", kind: "external", speaker: "Alice" },
      ],
    },
  ],
} satisfies LanguageDataset;

const perfectPairDataset = {
  id: "test",
  name: "Test",
  autonym: "Test",
  defaultSpeechLang: "und",
  phonemes: [
    { id: "test-a", ipa: "a", label: "a", category: "vowel" },
    { id: "test-e", ipa: "e", label: "e", category: "vowel" },
    { id: "test-i", ipa: "i", label: "i", category: "vowel" },
  ],
  contrasts: [],
  words: [
    {
      id: "test-word-pa",
      written: "pa",
      ipa: "/pa/",
      phonemeIds: ["test-a"],
      audio: [{ src: "pa.ogg", kind: "wiktionary" }],
    },
    {
      id: "test-word-be",
      written: "be",
      ipa: "/be/",
      phonemeIds: ["test-e"],
      audio: [{ src: "be.ogg", kind: "wiktionary" }],
    },
    {
      id: "test-word-ce",
      written: "ce",
      ipa: "/ce/",
      phonemeIds: ["test-e"],
      audio: [{ src: "ce.ogg", kind: "wiktionary" }],
    },
    {
      id: "test-word-pe",
      written: "pe",
      ipa: "/pe/",
      phonemeIds: ["test-e"],
      audio: [],
    },
    {
      id: "test-word-xi",
      written: "xi",
      ipa: "/xi/",
      phonemeIds: ["test-i"],
      audio: [],
    },
  ],
} satisfies LanguageDataset;

const optimisticPerfectPairDataset = {
  id: "test",
  name: "Test",
  autonym: "Test",
  defaultSpeechLang: "und",
  phonemes: [
    { id: "test-e", ipa: "e", label: "e", category: "vowel" },
    { id: "test-i", ipa: "i", label: "i", category: "vowel" },
  ],
  contrasts: [],
  words: [
    {
      id: "test-word-pe",
      written: "pe",
      ipa: "/pe/",
      phonemeIds: ["test-e"],
      audio: [],
    },
    {
      id: "test-word-pi",
      written: "pi",
      ipa: "/pi/",
      phonemeIds: ["test-i"],
      audio: [],
    },
    {
      id: "test-word-xi",
      written: "xi",
      ipa: "/xi/",
      phonemeIds: ["test-i"],
      audio: [],
    },
  ],
} satisfies LanguageDataset;

test("finds existing contribution words for a stored speaker name", () => {
  expect([...contributionWordIdsForSpeaker(testDataset, " alice ")].sort()).toEqual([
    "test-word-attribution",
    "test-word-speaker",
  ]);
});

test("does not skip words for a blank stored speaker name", () => {
  expect(contributionWordIdsForSpeaker(testDataset, "").size).toBe(0);
  expect(contributionWordIdsForSpeaker(testDataset, "   ").size).toBe(0);
});

test("excludes existing speaker contribution words from contribution queues", () => {
  const existingSpeakerWordIds = contributionWordIdsForSpeaker(testDataset, "Alice");
  const queue = createContributionQueue(testDataset, existingSpeakerWordIds);

  expect(queue.some((item) => existingSpeakerWordIds.has(item.word.id))).toBe(false);
  expect(queue.map((item) => item.word.id).sort()).toEqual([
    "test-word-external",
    "test-word-wiktionary",
  ]);
});

test("prioritizes words that add perfect phoneme pairs", () => {
  const queue = createContributionQueue(perfectPairDataset, new Set(), {
    candidateWordIds: new Set(["test-word-pe", "test-word-xi"]),
    limit: 1,
  });

  expect(queue[0]?.word.id).toBe("test-word-pe");
  expect(queue[0]?.perfectPairGain).toBe(1);
  expect(queue[0]?.perfectPairBaseCount).toBe(0);
  expect(queue[0]?.perfectPairPhonemeIds).toEqual(["test-a", "test-e"]);
});

test("uses assumed accepted words when scoring contribution queues", () => {
  const queue = createContributionQueue(optimisticPerfectPairDataset, new Set(), {
    assumedRecordedWordIds: ["test-word-pe"],
    candidateWordIds: new Set(["test-word-pi", "test-word-xi"]),
    limit: 1,
  });

  expect(queue[0]?.word.id).toBe("test-word-pi");
  expect(queue[0]?.perfectPairGain).toBe(1);
  expect(queue[0]?.perfectPairBaseCount).toBe(0);
  expect(queue[0]?.perfectPairPhonemeIds).toEqual(["test-e", "test-i"]);
});
