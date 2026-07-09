/// <reference types="bun-types" />

import { expect, test } from "bun:test";

import { createEmptyProgress, getTopConfusions, recordPromptResult, type AppProgress } from "../../src/storage/progress";

test("deduplicates existing opposite-direction confusions into one tricky pair", () => {
  const progress: AppProgress = {
    schemaVersion: 1,
    languages: {
      test: {
        itemStats: {},
        contrastStats: {
          "test-a-b": {
            attempts: 5,
            correct: 0,
            confusions: {
              "test-a->test-b": 2,
              "test-b->test-a": 3,
            },
            directionStats: {},
          },
        },
      },
    },
  };

  expect(getTopConfusions(progress, "test")).toEqual([{
    key: "test-a->test-b",
    contrastId: "test-a-b",
    heardPhonemeId: "test-a",
    chosenPhonemeId: "test-b",
    count: 3,
  }]);
});

test("records one confusion for a two-choice swapped answer", () => {
  const progress = recordPromptResult(createEmptyProgress(), {
    promptId: "prompt-1",
    languageId: "test",
    itemId: "item-1",
    contrastId: "test-a-b",
    recordedAt: 1_000,
    correct: false,
    answers: [
      {
        slotId: "slot-1",
        heardTermId: "term-a",
        chosenTermId: "term-b",
        heardPhonemeId: "test-a",
        chosenPhonemeId: "test-b",
        correct: false,
      },
      {
        slotId: "slot-2",
        heardTermId: "term-b",
        chosenTermId: "term-a",
        heardPhonemeId: "test-b",
        chosenPhonemeId: "test-a",
        correct: false,
      },
    ],
  });

  expect(progress.languages.test?.contrastStats["test-a-b"]?.confusions).toEqual({
    "test-a->test-b": 1,
  });
  expect(getTopConfusions(progress, "test")[0]?.count).toBe(1);
});
