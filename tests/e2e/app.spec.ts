import { expect, test, type Page } from "@playwright/test";

import { createContributionQueue, contributionWordIdsForSpeaker } from "../../src/contributions/queue";
import { getLanguageDataset } from "../../src/languages";

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
  await expect(page).toHaveURL(/lang=fr/);
  await expect(page).toHaveURL(/mode=match/);
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

  await expect(page).toHaveURL(/lang=en-GB/);
  await expect(page.getByRole("heading", { name: "British English sound library" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("vowel-trowel:last-language"))).toBe("en-GB");
});

test("uses last selected language when URL omits language", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vowel-trowel:last-language", "en-GB");
  });

  await page.goto("/?mode=match");

  await expect(page).toHaveURL(/lang=en-GB/);
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
  await expect(page).toHaveURL(/phonemes=en-gb-kit%2Cen-gb-fleece|phonemes=en-gb-kit,en-gb-fleece/);
});

test("opens target vowel practice", async ({ page }) => {
  await page.goto("/?lang=fr&mode=target");

  await expect(page.getByRole("button", { name: "Target vowels" })).toHaveClass(/selected/);
  await expect(page.getByRole("heading", { name: "Live vowel space" })).toBeVisible();
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

  await expect(page).toHaveURL(/explore=fr-s/);
  await expect(page.getByRole("heading", { name: "voiceless alveolar fricative" })).toBeVisible();
  await expect(page.locator(".phoneme-explorer .explore-word-card").first()).toBeVisible();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toHaveCount(0);
  await expect(page.locator(".phoneme-explorer").getByRole("button", { name: "Browser voice" })).toHaveCount(0);

  await page.getByLabel("Show words missing recordings").check();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toBeVisible();

  await page.getByRole("button", { name: "Back to sounds" }).click();

  await expect(page).not.toHaveURL(/explore=/);
  await expect(page.getByText("Current practice:")).toBeVisible();
});

test("can show fallback-only words when TTS flag is enabled", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-s,fr-z&tab=phonemes&explore=fr-s&tts=1");

  await expect(page.locator(".phoneme-explorer").getByText("saule")).toHaveCount(0);
  await page.getByLabel("Show words missing recordings").check();
  await expect(page.locator(".phoneme-explorer").getByText("saule")).toBeVisible();
  await expect(page.locator(".phoneme-explorer").getByRole("button", { name: "Browser voice" }).first()).toBeVisible();
  await expect(page.getByText("Browser voice", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/tts=1/);
});

test("opens a contribution recorder for a word", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes&explore=fr-u");

  const moueCard = page.locator(".explore-word-card").filter({ hasText: "moue" }).first();
  await moueCard.getByRole("button", { name: "Contribute a recording" }).click();

  await expect(page).toHaveURL(/contribute=fr-word-moue/);
  await expect(page.getByRole("heading", { name: "Record “moue”" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Licence" })).toHaveValue("CC0-1.0");
  await expect(page.getByPlaceholder("How you want to be credited")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download contribution zip" })).toBeDisabled();

  await page.getByRole("button", { name: "Back to sound library" }).click();
  await expect(page).not.toHaveURL(/contribute=/);
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
  await page.goto("/?lang=fr&mode=sort&phonemes=fr-u,fr-y&tab=phonemes");

  const wordBag = page.locator(".sort-bag");
  const groupTarget = page.locator(".sort-groups .sort-group").first();

  while (await wordBag.locator(".sort-word-card").count()) {
    await wordBag.locator(".sort-word-card").first().click();
    await groupTarget.click({ position: { x: 10, y: 170 } });
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
  await expect(page).not.toHaveURL(/hideSortWords=1/);
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
  await jeuneCard.getByRole("button", { name: "Play random recording" }).click();

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
