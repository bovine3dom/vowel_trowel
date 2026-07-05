import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { chromium, type Page } from "@playwright/test";

interface ScreenshotScenario {
  name: string;
  url: string;
  viewport: { width: number; height: number };
  action?: (page: Page) => Promise<void>;
}

const projectRoot = process.cwd();
const port = Number(process.env.UI_SCREENSHOT_PORT ?? 4174);
const baseUrl = process.env.UI_SCREENSHOT_BASE_URL ?? `http://127.0.0.1:${port}`;
const outputDir = process.env.UI_SCREENSHOT_DIR ?? join(projectRoot, "reports", "ui-screenshots");

const scenarios: readonly ScreenshotScenario[] = [
  {
    name: "01-match-desktop",
    url: "/?l=fr&p=fr-u,fr-y",
    viewport: { width: 1440, height: 1100 },
  },
  {
    name: "02-match-result-desktop",
    url: "/?l=fr&p=fr-u,fr-y",
    viewport: { width: 1440, height: 1100 },
    action: submitMatchingAnswer,
  },
  {
    name: "03-sort-desktop",
    url: "/?l=en-GB&m=s&p=en-gb-kit,en-gb-fleece&v=c",
    viewport: { width: 1440, height: 1100 },
  },
  {
    name: "04-sound-library-desktop",
    url: "/?l=fr&p=fr-u,fr-y",
    viewport: { width: 1440, height: 1400 },
  },
  {
    name: "05-explorer-desktop",
    url: "/?l=fr&p=fr-oe,fr-eu&x=fr-oe",
    viewport: { width: 1440, height: 1400 },
  },
  {
    name: "06-match-mobile",
    url: "/?l=fr&p=fr-u,fr-y",
    viewport: { width: 390, height: 1000 },
  },
  {
    name: "07-match-result-mobile",
    url: "/?l=fr&p=fr-u,fr-y",
    viewport: { width: 390, height: 1000 },
    action: submitMatchingAnswer,
  },
  {
    name: "08-sort-mobile",
    url: "/?l=en-GB&m=s&p=en-gb-kit,en-gb-fleece&v=c",
    viewport: { width: 390, height: 1000 },
  },
  {
    name: "09-sort-result-mobile",
    url: "/?l=en-GB&m=s&p=en-gb-kit,en-gb-fleece&v=c",
    viewport: { width: 390, height: 1000 },
    action: submitSortingAnswer,
  },
  {
    name: "10-contribution-desktop",
    url: "/?l=fr&m=c&w=fr-word-moue",
    viewport: { width: 1440, height: 1100 },
  },
  {
    name: "11-contribution-mobile",
    url: "/?l=fr&m=c&w=fr-word-moue",
    viewport: { width: 390, height: 1000 },
  },
];

let server: ChildProcess | undefined;

try {
  if (!process.env.UI_SCREENSHOT_BASE_URL && !(await isServerReady(baseUrl))) {
    server = spawn("bunx", [
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ], {
      cwd: projectRoot,
      stdio: "ignore",
    });
  }

  await waitForServer(baseUrl);
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch();

  try {
    for (const scenario of scenarios) {
      const page = await browser.newPage({
        deviceScaleFactor: 1,
        viewport: scenario.viewport,
      });

      await installMediaMocks(page);
      await page.goto(`${baseUrl}${scenario.url}`, { waitUntil: "networkidle" });
      await scenario.action?.(page);
      await settle(page);

      const path = join(outputDir, `${scenario.name}.png`);
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      console.log(path);
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  server?.kill();
}

async function installMediaMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class MockAudio {
      duration = 1.4;
      preload = "";
      src: string;
      currentTime = 0;

      constructor(src: string) {
        this.src = src;
      }

      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "ended") {
          window.setTimeout(() => {
            if (typeof listener === "function") {
              listener(new Event("ended"));
              return;
            }

            listener.handleEvent(new Event("ended"));
          }, 40);
        }
      }

      removeEventListener() {}
      pause() {}
      play() {
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, "Audio", { value: MockAudio });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        addEventListener() {},
        cancel() {},
        getVoices: () => [],
        removeEventListener() {},
        speak: (utterance: SpeechSynthesisUtterance) => {
          window.setTimeout(() => utterance.onend?.(new Event("end") as SpeechSynthesisEvent), 40);
        },
      },
    });
  });
}

async function submitMatchingAnswer(page: Page): Promise<void> {
  const soundButtons = page.locator(".match-column").first().getByRole("button");
  const wordButtons = page.locator(".match-column").nth(1).getByRole("button");

  await soundButtons.nth(0).click();
  await wordButtons.nth(0).click();
  await soundButtons.nth(1).click();
  await wordButtons.nth(1).click();
  await page.getByRole("button", { name: "Check answer" }).click();
}

async function submitSortingAnswer(page: Page): Promise<void> {
  const wordCards = page.locator(".sort-bag .sort-word-card");
  const count = await wordCards.count();

  for (let index = 0; index < count; index += 1) {
    const wordCard = page.locator(".sort-bag .sort-word-card").first();
    const phonemeId = await wordCard.getAttribute("data-phoneme");

    if (!phonemeId) {
      throw new Error("Sort word card is missing its phoneme id.");
    }

    await wordCard.click();
    await page
      .locator(`.sort-group[data-phoneme="${phonemeId}"]`)
      .first()
      .evaluate((element) => (element as HTMLElement).click());
  }

  await page.getByRole("button", { name: "Check answer" }).click();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(120);
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (await isServerReady(url)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function isServerReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
