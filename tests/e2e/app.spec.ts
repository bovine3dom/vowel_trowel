import { expect, test, type Page } from "@playwright/test";

import { createContributionQueue, contributionWordIdsForSpeaker } from "../../src/contributions/queue";
import { getLanguageDataset } from "../../src/languages";

const CONTRIBUTION_DRAFT_DB_NAME = "vowel-trowel-contribution-drafts";
const CONTRIBUTION_DRAFT_STORE_NAME = "drafts";

interface ContributionDraftSeedRecording {
  id?: string;
  wordId: string;
  recordedAt: string;
}

interface ContributionDraftSeed {
  id: string;
  mode: "single" | "batch";
  languageId: string;
  wordId?: string;
  licence: "CC0-1.0" | "CC-BY-4.0";
  speakerName: string;
  accent: string;
  keptRecordings: ContributionDraftSeedRecording[];
  currentRecording?: ContributionDraftSeedRecording;
  skippedWordIds: string[];
}

async function getMockClipboard(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as Window & { __vowelTrowelClipboard?: string }).__vowelTrowelClipboard ?? ""
  );
}

async function clearMockClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __vowelTrowelClipboard?: string }).__vowelTrowelClipboard = "";
  });
}

async function getSearchParams(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => Object.fromEntries(new URLSearchParams(window.location.search)));
}

async function seedContributionDraft(page: Page, draft: ContributionDraftSeed): Promise<void> {
  await page.evaluate(async ({ dbName, storeName, draft }) => {
    const db = await openDraftDb(dbName, storeName);

    try {
      const transaction = db.transaction(storeName, "readwrite");
      const transactionDone = transactionToPromise(transaction);
      const store = transaction.objectStore(storeName);
      const toStoredRecording = (recording: ContributionDraftSeedRecording, index: number) => {
        const blob = new Blob([new Uint8Array([index + 1, 20, 30, 40])], { type: "audio/webm" });

        return {
          ...recording,
          blob,
          mimeType: blob.type,
        };
      };

      store.put({
        schemaVersion: 1,
        ...draft,
        keptRecordings: draft.keptRecordings.map(toStoredRecording),
        currentRecording: draft.currentRecording
          ? toStoredRecording(draft.currentRecording, draft.keptRecordings.length)
          : undefined,
        updatedAt: "2026-01-02T03:04:05.000Z",
      });
      await transactionDone;
    } finally {
      db.close();
    }

    function openDraftDb(dbName: string, storeName: string): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);

        request.addEventListener("upgradeneeded", () => {
          const db = request.result;

          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "id" });
          }
        });
        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error));
      });
    }

    function transactionToPromise(transaction: IDBTransaction): Promise<void> {
      return new Promise((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("abort", () => reject(transaction.error));
        transaction.addEventListener("error", () => reject(transaction.error));
      });
    }
  }, { dbName: CONTRIBUTION_DRAFT_DB_NAME, storeName: CONTRIBUTION_DRAFT_STORE_NAME, draft });
}

async function contributionDraftExists(page: Page, id: string): Promise<boolean> {
  return page.evaluate(async ({ dbName, storeName, id }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.addEventListener("upgradeneeded", () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: "id" });
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });

    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(id);

        request.addEventListener("success", () => resolve(Boolean(request.result)));
        request.addEventListener("error", () => reject(request.error));
      });
    } finally {
      db.close();
    }
  }, { dbName: CONTRIBUTION_DRAFT_DB_NAME, storeName: CONTRIBUTION_DRAFT_STORE_NAME, id });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    class MockAudio {
      duration = 1.4;
      preload = "";
      src: string;
      private manualCurrentTime = 0;
      private startedAt: number | null = null;
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

      constructor(src: string) {
        this.src = src;
      }

      get currentTime() {
        if (this.startedAt === null) {
          return this.manualCurrentTime;
        }

        return Math.min(this.duration, this.manualCurrentTime + (performance.now() - this.startedAt) / 1000);
      }

      set currentTime(value: number) {
        this.manualCurrentTime = value;
        this.startedAt = null;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
      }

      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        this.listeners.get(type)?.delete(listener);
      }

      play() {
        this.startedAt = performance.now();
        return Promise.resolve();
      }

      pause() {
        this.manualCurrentTime = this.currentTime;
        this.startedAt = null;
      }
    }

    class MockAnalyser {
      fftSize = 4096;
      frequencyBinCount = 2048;
      smoothingTimeConstant = 0.72;

      connect() {}
      disconnect() {}

      getByteFrequencyData(data: Uint8Array) {
        for (let index = 0; index < data.length; index += 1) {
          data[index] = Math.round(120 + 80 * Math.sin(index / 20));
        }
      }
    }

    class MockAudioContext {
      destination = {};
      state = "running";
      sampleRate = 16_000;

      createAnalyser() {
        return new MockAnalyser();
      }

      createMediaElementSource() {
        return {
          connect() {},
          disconnect() {},
        };
      }

      decodeAudioData() {
        const sampleRate = this.sampleRate;
        const length = Math.floor(sampleRate * 1.4);
        const channel = new Float32Array(length);

        for (let index = 0; index < length; index += 1) {
          channel[index] = Math.sin((2 * Math.PI * 220 * index) / sampleRate)
            * Math.exp(-index / length);
        }

        return Promise.resolve({
          duration: length / sampleRate,
          getChannelData: () => channel,
          length,
          numberOfChannels: 1,
          sampleRate,
        });
      }

      resume() {
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, "Audio", { value: MockAudio });
    Object.defineProperty(window, "AudioContext", { value: MockAudioContext });
    Object.defineProperty(window, "webkitAudioContext", { value: MockAudioContext });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (value: string) => {
          (window as Window & { __vowelTrowelClipboard?: string }).__vowelTrowelClipboard = value;
          return Promise.resolve();
        },
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        addEventListener() {},
        cancel() {},
        getVoices: () => [],
        removeEventListener() {},
        speak: (utterance: SpeechSynthesisUtterance) => {
          queueMicrotask(() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent));
        },
      },
    });
  });
});

test("loads the French matching practice", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Vowel Trowel" })).toBeVisible();
  await expect(page.getByText("Hear two words, choose what you heard")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check answer" })).toBeDisabled();
  const panel = page.getByLabel("Spectrogram display");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Ready")).toBeVisible();
  await expect(panel.getByText("Play a recording to draw a spectrogram.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Replay" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Maximise" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "View Vowel Trowel on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/bovine3dom/vowel_trowel",
  );
  await expect(page).toHaveURL(/[?&]l=fr(?:&|$)/);
  await expect(page).not.toHaveURL(/lang=fr/);
  await expect(page).not.toHaveURL(/mode=match/);
  await expect(page).not.toHaveURL(/tab=phonemes/);
});

test("shows a friendly message when JavaScript is disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto("http://127.0.0.1:4173/");

    await expect(page.getByRole("heading", { name: "Vowel Trowel" })).toBeVisible();
    await expect(page.getByText(/needs JavaScript/i)).toBeVisible();
    await expect(page.getByText(/Please enable JavaScript/i)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("switches language through the selector", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("combobox", { name: /Language/ }).selectOption("en-GB");

  await expect(page).toHaveURL(/[?&]l=en-GB(?:&|$)/);
  await expect.poll(async () => {
    const params = await getSearchParams(page);

    return {
      language: params.l,
      legacyLanguage: params.lang,
    };
  }).toEqual({ language: "en-GB", legacyLanguage: undefined });
  await expect(page.getByRole("heading", { name: "British English sound library" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vowel-trowel:last-language"))).toBe("en-GB");
});

test("uses last selected language when URL omits language", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vowel-trowel:last-language", "en-GB");
  });

  await page.goto("/?mode=match");

  await expect(page).toHaveURL(/[?&]l=en-GB(?:&|$)/);
  await expect(page).not.toHaveURL(/mode=match/);
  await expect(page.getByRole("heading", { name: "British English sound library" })).toBeVisible();
});

test("opens sort mode from shareable URL parameters", async ({ page }) => {
  await page.goto("/?lang=en-GB&mode=sort&phonemes=en-gb-kit,en-gb-fleece&tab=contrasts");

  await expect(page.getByRole("button", { name: "Sort words" })).toHaveClass(/selected/);
  await expect(page.getByRole("heading", { name: "/ɪ/ vs /iː/" })).toBeVisible();
  await expect(page.getByText("Word bag")).toBeVisible();
  const sortCards = page.locator(".sort-bag .sort-word-card");
  await expect(sortCards.first()).toBeVisible();
  const sortCardCount = await sortCards.count();
  expect(sortCardCount).toBeGreaterThanOrEqual(2);
  expect(sortCardCount).toBeLessThanOrEqual(12);
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "en-GB",
    m: "s",
    p: "en-gb-kit,en-gb-fleece",
    v: "c",
  });
});

test("keeps old verbose contribution URLs working but canonicalizes them to contribution mode", async ({ page }) => {
  await page.goto("/?lang=en-GB&mode=match&tab=phonemes&phonemes=en-gb-lot,en-gb-thought&contribute=mode");

  await expect(page.getByRole("heading", { name: "Record a batch" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "en-GB",
    m: "c",
  });

  await page.goto("/?lang=fr&mode=match&tab=phonemes&phonemes=fr-u,fr-y&explore=fr-u&contribute=fr-word-moue&tts=1&showSounds=1");

  await expect(page.getByRole("heading", { name: "Record “moue”" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "fr",
    m: "c",
    w: "fr-word-moue",
  });
});

test("opens new short contribution URLs", async ({ page }) => {
  await page.goto("/?l=en-GB&m=c");

  await expect(page.getByRole("heading", { name: "Record a batch" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "en-GB",
    m: "c",
  });

  await page.goto("/?l=fr&m=c&w=fr-word-moue");

  await expect(page.getByRole("heading", { name: "Record “moue”" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "fr",
    m: "c",
    w: "fr-word-moue",
  });

  await page.goto("/?lang=fr&mode=contribute");

  await expect(page.getByRole("heading", { name: "Record a batch" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "fr",
    m: "c",
  });
});

test("keeps old verbose explorer URLs working but drops irrelevant defaults", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-s,fr-z&tab=phonemes&explore=fr-s&showSounds=1&tts=1");

  await expect(page.getByRole("heading", { name: "voiceless alveolar fricative" })).toBeVisible();
  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "fr",
    p: "fr-s,fr-z",
    x: "fr-s",
    t: "1",
  });
});

test("opens target vowel practice", async ({ page }) => {
  await page.goto("/?lang=fr&mode=target");

  await expect(page.getByRole("button", { name: "Target vowels" })).toHaveClass(/selected/);
  await expect(page.getByRole("heading", { name: "Live vowel space" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Lip shape" })).toBeVisible();
  await page.getByLabel("Live target vowel formant positions").click({ position: { x: 180, y: 260 } });
  await expect(page.locator(".lip-shape-svg")).toHaveAttribute("aria-label", /wide open/);
  await expect(page.getByRole("button", { name: "Start microphone" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Play / }).first()).toBeVisible();
  await expect(page.getByText("Choose one vowel to practise it, or choose two to practise a contrast.")).toBeVisible();
  await expect(page.locator(".phoneme-card.selected").first()).toBeVisible();
});

test("explores a sound and returns without adding an extra history entry", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-s,fr-z&tab=phonemes");

  const firstSoundCard = page.locator(".phoneme-card").filter({ hasText: "voiceless alveolar fricative" }).first();
  await expect(firstSoundCard.locator(".phoneme-examples")).toBeVisible();
  const exampleWordCount = await firstSoundCard.locator(".phoneme-example-word").count();
  expect(exampleWordCount).toBeGreaterThan(0);
  expect(exampleWordCount).toBeLessThanOrEqual(3);
  const playableExample = firstSoundCard.locator("button.phoneme-example-word").first();
  const playableExampleText = (await playableExample.textContent())?.trim();
  expect(playableExampleText).toBeTruthy();
  await playableExample.click();
  await expect(page.getByLabel("Spectrogram display").getByText(playableExampleText ?? "", { exact: true })).toBeVisible();

  const showUnrecordedSounds = page.getByLabel("Show sounds without recordings");
  if (await showUnrecordedSounds.count()) {
    await showUnrecordedSounds.check();
    await expect(page.locator(".phoneme-card.unrecorded .phoneme-example-word.missing-recording").first()).toBeVisible();
  }

  await firstSoundCard.getByRole("button", { name: "Explore words" }).click();

  await expect(page).toHaveURL(/[?&]x=fr-s(?:&|$)/);
  await expect(page.getByRole("heading", { name: "voiceless alveolar fricative" })).toBeVisible();
  await expect(page.locator(".phoneme-explorer .explore-word-card").first()).toBeVisible();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toHaveCount(0);
  await expect(page.locator(".phoneme-explorer").getByRole("button", { name: "Browser voice" })).toHaveCount(0);

  await page.getByLabel("Show words missing recordings").check();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toBeVisible();

  await page.getByRole("button", { name: "Back to sounds" }).click();

  await expect(page).not.toHaveURL(/[?&](?:x|explore)=/);
  await expect(page.getByText("Current practice:")).toBeVisible();
});

test("can show fallback-only words when TTS flag is enabled", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-s,fr-z&tab=phonemes&explore=fr-s&tts=1");

  await expect(page.locator(".phoneme-explorer").getByText("saule")).toHaveCount(0);
  await page.getByLabel("Show words missing recordings").check();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toBeVisible();
  await expect(page.locator(".phoneme-explorer").getByRole("button", { name: "Browser voice" }).first()).toBeVisible();
  await expect(page.getByText("Browser voice", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/[?&]t=1(?:&|$)/);
});

test("opens a contribution recorder for a word", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes&explore=fr-u");

  const moueCard = page.locator(".explore-word-card").filter({ hasText: "moue" }).first();
  await moueCard.getByRole("button", { name: "Contribute a recording" }).click();

  await expect.poll(() => getSearchParams(page)).toEqual({
    l: "fr",
    m: "c",
    w: "fr-word-moue",
  });
  await expect(page.getByRole("heading", { name: "Record “moue”" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Licence" })).toHaveValue("CC0-1.0");
  await expect(page.getByPlaceholder("How you want to be credited")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download contribution zip" })).toBeDisabled();

  await page.getByRole("button", { name: "Back to sound library" }).click();
  await expect(page).not.toHaveURL(/[?&](?:m=c|w=|contribute=)/);
});

test("skips contribution mode words already recorded by the stored speaker", async ({ page }) => {
  const language = getLanguageDataset("fr");
  const speakerName = "Louis";
  const expectedAvailableWords = createContributionQueue(
    language,
    contributionWordIdsForSpeaker(language, speakerName),
  ).length;

  expect(expectedAvailableWords).toBeLessThan(createContributionQueue(language).length);

  await page.addInitScript((details) => {
    localStorage.setItem("vowel-trowel:contribution-details:v1", JSON.stringify(details));
  }, {
    schemaVersion: 1,
    licence: "CC0-1.0",
    speakerName,
    accent: "",
  });
  await page.goto("/?lang=fr&contribute=mode");

  const availableSummary = page.locator(".contribution-queue-summary > div").first();

  await expect(page.getByRole("heading", { name: "Record a batch" })).toBeVisible();
  await expect(availableSummary.locator("strong")).toHaveText(String(expectedAvailableWords));
  await expect(availableSummary.locator("span")).toHaveText("words available");
  await expect(page.getByPlaceholder("How you want to be credited")).toHaveValue(speakerName);
});

test("restores contribution batch drafts across reloads and clears them after download", async ({ page }) => {
  const language = getLanguageDataset("fr");
  const queue = createContributionQueue(language);
  const keptItem = queue[0];
  const currentItem = queue.find((item) => item.word.id !== keptItem?.word.id);

  expect(keptItem).toBeTruthy();
  expect(currentItem).toBeTruthy();

  const draftId = "fr:batch";

  await page.goto("/");
  await seedContributionDraft(page, {
    id: draftId,
    mode: "batch",
    languageId: "fr",
    licence: "CC0-1.0",
    speakerName: "Saved Speaker",
    accent: "Saved Accent",
    keptRecordings: [{
      id: "fr-saved-kept-recording",
      wordId: keptItem!.word.id,
      recordedAt: "2026-01-02T03:04:05.000Z",
    }],
    currentRecording: {
      wordId: currentItem!.word.id,
      recordedAt: "2026-01-02T03:05:06.000Z",
    },
    skippedWordIds: [],
  });

  await page.goto("/?lang=fr&contribute=mode");

  await expect(page.getByRole("heading", { name: "Record a batch" })).toBeVisible();
  await expect(page.getByText("Restored 2 saved recordings from this browser.")).toBeVisible();
  await expect(page.getByPlaceholder("How you want to be credited")).toHaveValue("Saved Speaker");
  await expect(page.getByPlaceholder("e.g. Belgian French")).toHaveValue("Saved Accent");
  await expect(page.getByRole("heading", { name: currentItem!.word.written })).toBeVisible();
  await expect(page.locator(".contribution-queue-summary > div").nth(1).locator("strong")).toHaveText("1");
  await expect(page.getByRole("button", { name: "Finish and download ZIP" })).toBeEnabled();

  await page.reload();

  await expect(page.getByText("Restored 2 saved recordings from this browser.")).toBeVisible();
  await expect(page.getByRole("heading", { name: currentItem!.word.written })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish and download ZIP" })).toBeEnabled();

  const downloadPromise = page.waitForEvent("download");

  await page.getByRole("button", { name: "Finish and download ZIP" }).click();
  await downloadPromise;
  await expect(page.getByRole("button", { name: "Downloaded" })).toBeDisabled();
  await expect.poll(() => contributionDraftExists(page, draftId)).toBe(false);
});

test("can submit a matching answer", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes");

  const soundButtons = page.locator(".match-column").first().getByRole("button");
  const wordButtons = page.locator(".match-column").nth(1).getByRole("button");

  await soundButtons.nth(0).click();
  await wordButtons.nth(0).click();
  await soundButtons.nth(1).click();
  await wordButtons.nth(1).click();
  await page.getByRole("button", { name: "Check answer" }).click();

  await expect(page.getByText(/Correct|Not quite/)).toBeVisible();
  await expect(page.getByRole("button", { name: "New pair" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next contrast" })).toBeVisible();

  await page.getByRole("button", { name: "New pair" }).click();

  await expect(page.getByText(/Correct|Not quite/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check answer" })).toBeDisabled();
});

test("keeps match sample identity out of the spectrogram label", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes");

  await page.locator(".match-column").first().getByRole("button").first().click();

  const panel = page.getByLabel("Spectrogram display");

  await expect(panel.getByText(/Sample [AB]/)).toBeVisible();
  await expect(panel.getByText("mue", { exact: true })).toHaveCount(0);
  await expect(panel.getByText("moue", { exact: true })).toHaveCount(0);

  const copyButton = panel.getByRole("button", { name: "Copy track link" });
  await copyButton.click();
  await expect(copyButton).toHaveAttribute("title", "Track link copied");
  await expect(copyButton).toHaveText("Track link copied");
  await expect.poll(() => getMockClipboard(page)).toMatch(/^audio\/fr\/approved\//);
});

test("copies distinct filepaths for distinct explorer recordings", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-oe,fr-eu&tab=phonemes&explore=fr-oe");

  const soeurCard = page.locator(".explore-word-card").filter({ hasText: "sœur" }).first();
  const trackRows = soeurCard.locator(".track-row");
  await expect(trackRows.nth(1)).toBeVisible();

  await trackRows.nth(0).getByRole("button", { name: "Copy track link" }).click();
  await expect.poll(() => getMockClipboard(page)).toMatch(/^audio\/fr\/approved\/soeur\//);
  const firstPath = await getMockClipboard(page);

  await clearMockClipboard(page);
  await trackRows.nth(1).getByRole("button", { name: "Copy track link" }).click();
  await expect.poll(() => getMockClipboard(page)).toMatch(/^audio\/fr\/approved\/soeur\//);
  const secondPath = await getMockClipboard(page);

  expect(secondPath).not.toBe(firstPath);
  expect(firstPath).toContain("audio/fr/approved/soeur/");
  expect(secondPath).toContain("audio/fr/approved/soeur/");

  const lastTrackRow = trackRows.nth(await trackRows.count() - 1);
  await clearMockClipboard(page);
  await lastTrackRow.getByRole("button", { name: "Copy track link" }).click();
  await expect.poll(() => getMockClipboard(page)).toMatch(/^audio\/fr\/approved\/soeur\//);
  const expectedRandomPath = await getMockClipboard(page);

  await clearMockClipboard(page);
  await page.evaluate(() => {
    Math.random = () => 0.999;
  });
  await soeurCard.getByRole("button", { name: "Play random recording" }).click();

  const panel = page.getByLabel("Spectrogram display");
  await expect(panel.getByText("sœur")).toBeVisible();
  await panel.getByRole("button", { name: "Copy track link" }).click();
  await expect.poll(() => getMockClipboard(page)).toBe(expectedRandomPath);
});

test("can submit a sorting answer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?lang=fr&mode=sort&phonemes=fr-u,fr-y&tab=phonemes");

  const wordBag = page.locator(".sort-bag");
  const placeTargets = page.getByRole("button", { name: "Tap here to place sample" });
  const placeTarget = placeTargets.first();

  await expect(wordBag.locator(".sort-word-card").first()).toBeVisible();
  await expect(placeTargets).toHaveCount(2);
  await expect(placeTarget).toBeVisible();
  expect((await placeTarget.boundingBox())?.height).toBeGreaterThanOrEqual(70);

  while (await wordBag.locator(".sort-word-card").count()) {
    await wordBag.locator(".sort-word-card").first().click();
    await placeTarget.click();
  }

  await page.getByRole("button", { name: "Check answer" }).click();

  await expect(page.getByText(/Correct|Not quite/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Play again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next contrast" })).toBeVisible();

  await page.getByRole("button", { name: "Next contrast" }).click();

  await expect(page.getByText(/Correct|Not quite/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check answer" })).toBeDisabled();
});

test("can hide sort word names behind sample labels", async ({ page }) => {
  await page.goto("/?lang=fr&mode=sort&phonemes=fr-u,fr-y&tab=phonemes&hideSortWords=1");

  await expect(page.getByLabel("Hide word names")).toBeChecked();
  const firstCard = page.locator(".sort-bag .sort-word-card").first();
  const wordText = firstCard.locator(".word-text");
  await expect(wordText).toHaveText(/^Sample [A-Z]+$/);
  const sampleLabel = (await wordText.textContent())?.trim() ?? "";

  await firstCard.click();
  await expect(page.getByLabel("Spectrogram display").getByText(sampleLabel, { exact: true })).toBeVisible();

  await page.getByLabel("Hide word names").uncheck();
  await expect(page).not.toHaveURL(/[?&](?:h|hideSortWords)=1/);
  await expect(wordText).not.toHaveText(/^Sample /);
});

test("limits credits to the current practice view", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes");

  const currentWords = await page.locator(".match-column").nth(1).locator(".word-button").evaluateAll((buttons) =>
    buttons.map((button) => ({
      written: button.querySelector(".word-text")?.textContent?.trim() ?? "",
      ipa: button.querySelector(".word-ipa")?.textContent?.trim() ?? "",
    }))
  );

  await page.getByText("Audio credits").click();

  for (const word of currentWords) {
    await expect(page.getByText(`${word.written} ${word.ipa}`)).toBeVisible();
  }

  await expect(page.getByText("jeune /ʒœn/")).toHaveCount(0);
});

test("updates the spectrogram when a reviewed recording plays", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-oe,fr-eu&tab=phonemes&explore=fr-oe");

  const jeuneCard = page.locator(".explore-word-card").filter({ hasText: "jeune" }).first();
  const explorerFlagButton = jeuneCard.getByRole("button", { name: "Copy track link" }).first();
  await expect(explorerFlagButton).toBeVisible();
  await explorerFlagButton.click();
  await expect.poll(() => getMockClipboard(page)).toMatch(/^audio\/fr\/approved\/jeune\//);
  await jeuneCard.getByRole("button", { name: "Play track 1" }).click();

  const panel = page.getByLabel("Spectrogram display");

  await expect(panel.getByText("jeune")).toBeVisible();
  await expect(panel.getByText(/Swiss French|wiktionary/)).toBeVisible();

  await panel.getByRole("button", { name: "Maximise" }).click();
  await expect(panel).toHaveClass(/expanded/);
  await expect(panel.getByRole("button", { name: "Close" })).toBeVisible();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).not.toHaveClass(/expanded/);

  const replay = panel.getByRole("button", { name: "Replay" });
  await expect(replay).toBeEnabled();
  await replay.click();
  await expect(panel.getByText("jeune")).toBeVisible();
});
