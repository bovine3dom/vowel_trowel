import { expect, test } from "@playwright/test";

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
  await expect(page.getByLabel("Spectrogram display")).toBeVisible();
  await expect(page.getByLabel("Spectrogram display").locator(".spectrogram-status")).toHaveText("Ready");
  await expect(page.getByLabel("Spectrogram display").getByRole("button", { name: "Replay" })).toBeDisabled();
  await expect(page.getByLabel("Spectrogram display").getByRole("button", { name: "Maximise" })).toBeEnabled();
  await expect(page).toHaveURL(/lang=fr/);
  await expect(page).toHaveURL(/mode=match/);
});

test("switches language through the selector", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("combobox", { name: /Language/ }).selectOption("en-GB");

  await expect(page).toHaveURL(/lang=en-GB/);
  await expect(page.getByRole("heading", { name: "British English sound library" })).toBeVisible();
});

test("opens sort mode from shareable URL parameters", async ({ page }) => {
  await page.goto("/?lang=en-GB&mode=sort&phonemes=en-gb-kit,en-gb-fleece&tab=contrasts");

  await expect(page.getByRole("button", { name: "Sort words" })).toHaveClass(/selected/);
  await expect(page.getByRole("heading", { name: "/ɪ/ vs /iː/" })).toBeVisible();
  await expect(page.getByText("Word bag")).toBeVisible();
  await expect(page.getByRole("button", { name: /ship/i })).toBeVisible();
  await expect(page).toHaveURL(/phonemes=en-gb-kit%2Cen-gb-fleece|phonemes=en-gb-kit,en-gb-fleece/);
});

test("explores a sound and returns without adding an extra history entry", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-u,fr-y&tab=phonemes");

  const firstSoundCard = page.locator(".phoneme-card").filter({ hasText: "/u/" }).first();
  await firstSoundCard.getByRole("button", { name: "Explore words" }).click();

  await expect(page).toHaveURL(/explore=fr-u/);
  await expect(page.getByRole("heading", { name: "close back rounded vowel" })).toBeVisible();
  await expect(page.locator(".phoneme-explorer").getByText("roue")).toBeVisible();

  await page.getByRole("button", { name: "Back to sounds" }).click();

  await expect(page).not.toHaveURL(/explore=/);
  await expect(page.getByText("Current practice:")).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Next pair" })).toBeVisible();
});

test("limits credits to the current practice view", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-an,fr-in&tab=phonemes");

  await page.getByText("Audio credits").click();

  await expect(page.getByText("No recordings are used in the current view")).toBeVisible();
  await expect(page.getByText("jeune /ʒœn/")).toHaveCount(0);
});

test("updates the spectrogram when a reviewed recording plays", async ({ page }) => {
  await page.goto("/?lang=fr&mode=match&phonemes=fr-oe,fr-eu&tab=phonemes&explore=fr-oe");

  const jeuneCard = page.locator(".explore-word-card").filter({ hasText: "jeune" }).first();
  await jeuneCard.getByRole("button", { name: "Play recording" }).click();

  const panel = page.getByLabel("Spectrogram display");

  await expect(panel.getByText("Playing")).toBeVisible();
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
  await expect(panel.locator(".spectrogram-status")).toHaveText("Playing");
});
