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
