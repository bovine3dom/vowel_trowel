import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import * as path from "node:path";

const rootDir = path.join(import.meta.dir, "..");
const generatorScript = path.join(rootDir, "scripts", "generate-contribution-perfect-pairs.ts");
const defaultViteArgs = ["--host", "0.0.0.0"];
const viteArgs = normalizeArgs(process.argv.slice(2));

let generatorRunning = false;
let generatorPending = false;
let generatorTimer: ReturnType<typeof setTimeout> | undefined;
let watcherRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let closed = false;
const watchers: FSWatcher[] = [];

await runGenerator(true);
refreshWatchers();

const vite = spawn(process.execPath, ["x", "vite", ...(viteArgs.length > 0 ? viteArgs : defaultViteArgs)], {
  cwd: rootDir,
  stdio: "inherit",
  env: process.env,
});

vite.on("exit", (code, signal) => {
  shutdown(code ?? (signal ? 1 : 0));
});

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

function normalizeArgs(args: readonly string[]): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

function scheduleGeneratorRun(): void {
  if (closed) {
    return;
  }

  if (generatorTimer) {
    clearTimeout(generatorTimer);
  }

  generatorTimer = setTimeout(() => {
    void runGenerator(false).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });
  }, 100);
}

async function runGenerator(failOnError: boolean): Promise<void> {
  if (generatorRunning) {
    generatorPending = true;
    return;
  }

  generatorRunning = true;

  try {
    await spawnGenerator(failOnError);
  } finally {
    generatorRunning = false;

    if (generatorPending && !closed) {
      generatorPending = false;
      await runGenerator(failOnError);
    }
  }
}

function spawnGenerator(failOnError: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["run", generatorScript], {
      cwd: rootDir,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const error = new Error(`Contribution priority generation failed with exit code ${code}.`);

      if (failOnError) {
        reject(error);
        return;
      }

      console.error(error.message);
      resolve();
    });
  });
}

function refreshWatchers(): void {
  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }

  for (const watchPath of collectWatchPaths()) {
    try {
      watchers.push(watch(watchPath, () => {
        scheduleGeneratorRun();
        scheduleWatcherRefresh();
      }));
    } catch (error) {
      console.warn(`Could not watch ${path.relative(rootDir, watchPath)}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

function scheduleWatcherRefresh(): void {
  if (watcherRefreshTimer) {
    clearTimeout(watcherRefreshTimer);
  }

  watcherRefreshTimer = setTimeout(() => {
    if (!closed) {
      refreshWatchers();
    }
  }, 500);
}

function collectWatchPaths(): string[] {
  return [
    ...collectDirectories(path.join(rootDir, "src", "languages")),
    path.join(rootDir, "src", "contributions", "perfect-pair-data.ts"),
    path.join(rootDir, "src", "languages", "resolve.ts"),
    generatorScript,
  ].filter((watchPath) => existsSync(watchPath));
}

function collectDirectories(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  const directories = [directory];

  for (const entry of readdirSync(directory)) {
    const childPath = path.join(directory, entry);

    if (statSync(childPath).isDirectory()) {
      directories.push(...collectDirectories(childPath));
    }
  }

  return directories;
}

function shutdown(exitCode: number): void {
  if (closed) {
    return;
  }

  closed = true;

  if (generatorTimer) {
    clearTimeout(generatorTimer);
  }

  if (watcherRefreshTimer) {
    clearTimeout(watcherRefreshTimer);
  }

  for (const watcher of watchers.splice(0)) {
    watcher.close();
  }

  if (!vite.killed) {
    vite.kill();
  }

  process.exit(exitCode);
}
