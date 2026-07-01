import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import { getLanguageDataset, getLanguageSlug, sameLanguageId } from "../src/languages";
import type { AudioSource, WordEntry } from "../src/languages/types";
import {
  DEFAULT_REVIEW_STATE_PATH,
  createCandidateKey,
  getStoredReview,
  loadReviewState,
  type AudioReviewState,
  type CandidateReview,
} from "./audio-review-state";

type DownloadMode = "none" | "regional" | "all";

interface CliOptions {
  languageId: string;
  words: string[];
  limit: number | null;
  output: string;
  markdown: string | null;
  sourceWikis: SourceWiki[];
  maxCandidatesPerWord: number;
  delayMs: number;
  retries: number;
  timeoutMs: number;
  email: string;
  download: DownloadMode;
  downloadDir: string;
  reviewStatePath: string;
  forceDownloadReviewed: boolean;
}

interface SourceWiki {
  code: "fr" | "en";
  host: string;
}

interface WikiPageAudio {
  wiki: string;
  pageTitle: string;
  missing: boolean;
  files: string[];
}

interface CommonsAudioInfo {
  fileTitle: string;
  audioUrl: string | null;
  commonsUrl: string;
  mime: string | null;
  size: number | null;
  license: string | null;
  licenseShortName: string | null;
  artist: string | null;
  credit: string | null;
  attribution: string | null;
  description: string | null;
}

interface AudioCandidate extends CommonsAudioInfo {
  key: string;
  sourceWikis: string[];
  regions: string[];
  score: number;
  reasons: string[];
  suggestedAudioSource: AudioSource;
  review: CandidateReview;
  localPath?: string;
  metadataPath?: string;
  datasetSrc?: string;
}

interface DownloadedCandidatePaths {
  localPath: string;
  metadataPath: string;
  datasetSrc: string;
}

interface WordAudioReport {
  wordId: string;
  written: string;
  ipa: string;
  phonemeIds: readonly string[];
  pages: WikiPageAudio[];
  candidates: AudioCandidate[];
}

interface AudioReport {
  generatedAt: string;
  language: {
    id: string;
    name: string;
  };
  userAgent: string;
  sourceWikis: string[];
  summary: {
    totalWords: number;
    wordsWithCandidates: number;
    wordsWithRegionalCandidates: number;
    totalCandidates: number;
    downloadedCandidates: number;
  };
  words: WordAudioReport[];
}

interface QueryPage {
  title?: string;
  missing?: string;
  images?: Array<{ title?: string }>;
  imageinfo?: Array<{
    url?: string;
    descriptionurl?: string;
    mime?: string;
    size?: number;
    extmetadata?: Record<string, { value?: string }>;
  }>;
}

const DEFAULT_FRENCH_SOURCE_WIKIS: SourceWiki[] = [
  { code: "fr", host: "fr.wiktionary.org" },
  { code: "en", host: "en.wiktionary.org" },
];
const DEFAULT_ENGLISH_SOURCE_WIKIS: SourceWiki[] = [
  { code: "en", host: "en.wiktionary.org" },
];
const AUDIO_EXTENSIONS = new Set(["oga", "ogg", "opus", "mp3", "wav", "webm", "flac", "m4a"]);
const AUDIO_MIME_PREFIX = "audio/";

const options = parseArgs(process.argv.slice(2));
const dataset = getLanguageDataset(options.languageId);
const userAgent = createUserAgent(options.email);
const targetWords = selectWords(dataset.words, options);
const reviewState = await loadReviewState(options.reviewStatePath);
const report = await buildReport(targetWords, options, userAgent, reviewState, dataset.name);

await writeJson(options.output, report);

if (options.markdown) {
  await writeText(options.markdown, renderMarkdown(report));
}

printSummary(report, options);

async function buildReport(
  words: readonly WordEntry[],
  opts: CliOptions,
  ua: string,
  reviewState: AudioReviewState,
  languageName: string,
): Promise<AudioReport> {
  const pagesByWord = new Map<string, WikiPageAudio[]>();
  const fileSourcesByWord = new Map<string, Map<string, Set<string>>>();

  for (const sourceWiki of opts.sourceWikis) {
    const pages = await fetchPagesForWords(sourceWiki, words, opts, ua);

    for (const [wordId, page] of pages) {
      pagesByWord.set(wordId, [...(pagesByWord.get(wordId) ?? []), page]);

      const fileSources = fileSourcesByWord.get(wordId) ?? new Map<string, Set<string>>();

      for (const fileTitle of page.files) {
        const sources = fileSources.get(fileTitle) ?? new Set<string>();
        sources.add(sourceWiki.host);
        fileSources.set(fileTitle, sources);
      }

      fileSourcesByWord.set(wordId, fileSources);
    }
  }

  const allFileTitles = new Set<string>();

  for (const fileSources of fileSourcesByWord.values()) {
    for (const fileTitle of fileSources.keys()) {
      allFileTitles.add(fileTitle);
    }
  }

  const commonsInfo = await fetchCommonsInfo([...allFileTitles], opts, ua);
  const wordReports: WordAudioReport[] = [];
  let downloadedCandidates = 0;

  for (const word of words) {
    const fileSources = fileSourcesByWord.get(word.id) ?? new Map<string, Set<string>>();
    const candidates = [...fileSources.entries()]
      .flatMap(([fileTitle, sources]) => {
        const info = commonsInfo.get(fileTitle);

        if (!info || !info.audioUrl || !isAudioInfo(info)) {
          return [];
        }

        return [applyStoredReview(word, scoreCandidate(word, info, [...sources], opts.languageId), reviewState)];
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, opts.maxCandidatesPerWord);

    if (opts.download !== "none") {
      for (const candidate of candidates) {
        if (opts.download === "regional" && candidate.regions.length === 0) {
          continue;
        }

        if (!candidate.audioUrl) {
          continue;
        }

        if (candidate.review.status !== "pending" && !opts.forceDownloadReviewed) {
          continue;
        }

        const paths = await downloadCandidate(word, candidate, opts, ua);

        candidate.localPath = paths.localPath;
        candidate.metadataPath = paths.metadataPath;
        candidate.datasetSrc = paths.datasetSrc;
        candidate.suggestedAudioSource = {
          ...candidate.suggestedAudioSource,
          src: paths.datasetSrc,
        };
        downloadedCandidates += 1;
      }
    }

    wordReports.push({
      wordId: word.id,
      written: word.written,
      ipa: word.ipa,
      phonemeIds: word.phonemeIds,
      pages: pagesByWord.get(word.id) ?? [],
      candidates,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    language: {
      id: opts.languageId,
      name: languageName,
    },
    userAgent: ua,
    sourceWikis: opts.sourceWikis.map((wiki) => wiki.host),
    summary: {
      totalWords: wordReports.length,
      wordsWithCandidates: wordReports.filter((word) => word.candidates.length > 0).length,
      wordsWithRegionalCandidates: wordReports.filter((word) =>
        word.candidates.some((candidate) => candidate.regions.length > 0),
      ).length,
      totalCandidates: wordReports.reduce((total, word) => total + word.candidates.length, 0),
      downloadedCandidates,
    },
    words: wordReports,
  };
}

async function fetchPagesForWords(
  sourceWiki: SourceWiki,
  words: readonly WordEntry[],
  opts: CliOptions,
  ua: string,
): Promise<Map<string, WikiPageAudio>> {
  const result = new Map<string, WikiPageAudio>();

  for (const batch of chunk(words, 25)) {
    const byExactTitle = new Map(batch.map((word) => [normalizeExactText(word.written), word]));
    const byFallbackTitle = createUnambiguousFallbackTitleMap(batch);
    const pages = await mediaWikiQueryPages(sourceWiki.host, {
      action: "query",
      format: "json",
      formatversion: "2",
      redirects: "1",
      prop: "images",
      imlimit: "max",
      titles: batch.map((word) => word.written).join("|"),
    }, opts, ua);

    for (const page of pages) {
      const title = page.title ?? "";
      const word = byExactTitle.get(normalizeExactText(title))
        ?? byFallbackTitle.get(normalizeSearchText(title));

      if (!word) {
        continue;
      }

      result.set(word.id, {
        wiki: sourceWiki.host,
        pageTitle: title,
        missing: Boolean(page.missing),
        files: (page.images ?? [])
          .map((image) => image.title)
          .filter((title): title is string => Boolean(title))
          .filter(isAudioFileTitle)
          .map(canonicalizeFileTitle),
      });
    }
  }

  for (const word of words) {
    result.set(word.id, result.get(word.id) ?? {
      wiki: sourceWiki.host,
      pageTitle: word.written,
      missing: true,
      files: [],
    });
  }

  return result;
}

async function fetchCommonsInfo(
  fileTitles: readonly string[],
  opts: CliOptions,
  ua: string,
): Promise<Map<string, CommonsAudioInfo>> {
  const result = new Map<string, CommonsAudioInfo>();

  for (const batch of chunk(fileTitles, 25)) {
    if (batch.length === 0) {
      continue;
    }

    const pages = await mediaWikiQueryPages("commons.wikimedia.org", {
      action: "query",
      format: "json",
      formatversion: "2",
      prop: "imageinfo",
      iiprop: "url|mime|size|extmetadata",
      titles: batch.join("|"),
    }, opts, ua);

    for (const page of pages) {
      const imageInfo = page.imageinfo?.[0];
      const title = page.title;

      if (!title || !imageInfo) {
        continue;
      }

      const metadata = imageInfo.extmetadata ?? {};
      const info = {
        fileTitle: title,
        audioUrl: imageInfo.url ?? null,
        commonsUrl: imageInfo.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        mime: imageInfo.mime ?? null,
        size: imageInfo.size ?? null,
        license: metadata.License?.value ?? null,
        licenseShortName: metadata.LicenseShortName?.value ?? null,
        artist: stripHtml(metadata.Artist?.value ?? null),
        credit: stripHtml(metadata.Credit?.value ?? null),
        attribution: stripHtml(metadata.Attribution?.value ?? null),
        description: stripHtml(metadata.ImageDescription?.value ?? null),
      };

      result.set(canonicalizeFileTitle(title), info);
    }
  }

  return result;
}

function scoreCandidate(
  word: WordEntry,
  info: CommonsAudioInfo,
  sourceWikis: string[],
  languageId: string,
): AudioCandidate {
  const haystack = normalizeSearchText([
    info.fileTitle,
    info.description,
    info.artist,
    info.credit,
    info.attribution,
    info.license,
    info.licenseShortName,
    sourceWikis.join(" "),
  ].filter(Boolean).join(" "));
  const normalizedWord = normalizeSearchText(word.written);
  const regions = detectRegions(haystack);
  const reasons: string[] = [];
  let score = 0;

  if (haystack.includes(normalizedWord)) {
    score += 4;
    reasons.push("file metadata/title contains word");
  }

  if (sameLanguageId(languageId, "fr") && hasFrenchLanguageMarker(haystack)) {
    score += 3;
    reasons.push("metadata suggests French audio");
  }

  if (sameLanguageId(languageId, "en-GB") && hasEnglishLanguageMarker(haystack)) {
    score += 4;
    reasons.push("metadata suggests English audio");
  }

  if (sameLanguageId(languageId, "en-GB") && hasFrenchLanguageMarker(haystack)) {
    score -= 6;
    reasons.push("metadata suggests non-English audio");
  }

  if (sourceWikis.includes(primaryWiktionaryHost(languageId))) {
    score += 2;
    reasons.push("found on primary Wiktionary page");
  }

  if (regions.length > 0) {
    score += 10 + regions.length;
    reasons.push(`regional keyword: ${regions.join(", ")}`);
  }

  if (info.mime?.startsWith(AUDIO_MIME_PREFIX)) {
    score += 1;
    reasons.push(`audio MIME ${info.mime}`);
  }

  return {
    ...info,
    key: createCandidateKey({ wordId: word.id, fileTitle: info.fileTitle, commonsUrl: info.commonsUrl }),
    sourceWikis,
    regions,
    score,
    reasons,
    suggestedAudioSource: {
      src: info.audioUrl ?? "",
      kind: "wiktionary",
      license: info.licenseShortName ?? info.license ?? undefined,
      attribution: info.attribution ?? info.artist ?? info.credit ?? undefined,
      sourceUrl: info.commonsUrl,
      notes: regions.length > 0 ? `Regional candidate: ${regions.join(", ")}` : undefined,
    },
    review: {
      status: "pending",
      accent: regions[0],
      notes: "Listen before approving. Check whether the target contrast is actually preserved.",
    },
  };
}

function applyStoredReview(
  word: WordEntry,
  candidate: AudioCandidate,
  reviewState: AudioReviewState,
): AudioCandidate {
  const stored = getStoredReview(reviewState, {
    wordId: word.id,
    fileTitle: candidate.fileTitle,
    commonsUrl: candidate.commonsUrl,
  });

  if (!stored) {
    return candidate;
  }

  const suggestedAudioSource = {
    ...candidate.suggestedAudioSource,
    ...stored.suggestedAudioSource,
    src: stored.datasetSrc ?? stored.suggestedAudioSource?.src ?? candidate.suggestedAudioSource.src,
  };

  return {
    ...candidate,
    localPath: stored.localPath ?? candidate.localPath,
    metadataPath: stored.metadataPath ?? candidate.metadataPath,
    datasetSrc: stored.datasetSrc ?? candidate.datasetSrc,
    suggestedAudioSource,
    review: {
      status: stored.status,
      accent: stored.accent ?? candidate.review.accent,
      notes: stored.notes ?? candidate.review.notes,
    },
  };
}

async function downloadCandidate(
  word: WordEntry,
  candidate: AudioCandidate,
  opts: CliOptions,
  ua: string,
): Promise<DownloadedCandidatePaths> {
  if (!candidate.audioUrl) {
    throw new Error(`Candidate ${candidate.fileTitle} has no audio URL.`);
  }

  const url = new URL(candidate.audioUrl);
  const filename = sanitizeFilename(decodeURIComponent(path.basename(url.pathname)));
  const relativePath = path.join(opts.downloadDir, sanitizeFilename(word.id), filename);
  const metadataRelativePath = `${relativePath}.metadata.json`;
  const outputPath = path.resolve(relativePath);
  const metadataPath = path.resolve(metadataRelativePath);
  const response = await fetchWithPolicy(candidate.audioUrl, opts, ua);
  const data = new Uint8Array(await response.arrayBuffer());

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, data);
  await writeJson(metadataPath, {
    downloadedAt: new Date().toISOString(),
    word: {
      id: word.id,
      written: word.written,
      ipa: word.ipa,
      phonemeIds: word.phonemeIds,
    },
    candidate: {
      ...candidate,
      localPath: relativePath,
      metadataPath: metadataRelativePath,
      datasetSrc: toDatasetAudioSrc(relativePath),
    },
  });

  return {
    localPath: relativePath,
    metadataPath: metadataRelativePath,
    datasetSrc: toDatasetAudioSrc(relativePath),
  };
}

async function mediaWikiQuery(
  host: string,
  params: Record<string, string>,
  opts: CliOptions,
  ua: string,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    const query = new URLSearchParams({ maxlag: "5", ...params });
    const url = `https://${host}/w/api.php?${query.toString()}`;
    const response = await fetchWithPolicy(url, opts, ua);
    const data = await response.json();
    const apiError = getMediaWikiError(data);

    if (!apiError) {
      return data;
    }

    if (apiError.code === "maxlag" || apiError.code === "ratelimited") {
      lastError = new Error(`MediaWiki API ${apiError.code}: ${apiError.info ?? "retry requested"}`);
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new Error(`MediaWiki API ${apiError.code}: ${apiError.info ?? "unknown error"}`);
  }

  throw lastError instanceof Error ? lastError : new Error(`MediaWiki API request failed for ${host}.`);
}

async function mediaWikiQueryPages(
  host: string,
  params: Record<string, string>,
  opts: CliOptions,
  ua: string,
): Promise<QueryPage[]> {
  const pagesByTitle = new Map<string, QueryPage>();
  let continueParams: Record<string, string> | null = {};

  while (continueParams) {
    const data = await mediaWikiQuery(host, { ...params, ...continueParams }, opts, ua);

    for (const page of getQueryPages(data)) {
      const title = page.title ?? `page-${pagesByTitle.size}`;
      pagesByTitle.set(title, mergeQueryPages(pagesByTitle.get(title), page));
    }

    continueParams = getContinueParams(data);
  }

  return [...pagesByTitle.values()];
}

async function fetchWithPolicy(url: string, opts: CliOptions, ua: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    if (opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": ua,
          Accept: "application/json, audio/*;q=0.9, */*;q=0.8",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        return response;
      }

      if (response.status === 429 || response.status === 503) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(retryAfterMs ?? backoffMs(attempt));
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }

      if (response.status >= 500 && attempt < opts.retries) {
        await sleep(backoffMs(attempt));
        lastError = new Error(`HTTP ${response.status} from ${url}`);
        continue;
      }

      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;

      if (attempt >= opts.retries) {
        break;
      }

      await sleep(backoffMs(attempt));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

function getQueryPages(data: unknown): QueryPage[] {
  if (!isRecord(data)) {
    return [];
  }

  const query = data.query;

  if (!isRecord(query)) {
    return [];
  }

  const pages = query.pages;

  if (Array.isArray(pages)) {
    return pages as QueryPage[];
  }

  if (isRecord(pages)) {
    return Object.values(pages) as QueryPage[];
  }

  return [];
}

function mergeQueryPages(existing: QueryPage | undefined, incoming: QueryPage): QueryPage {
  if (!existing) {
    return incoming;
  }

  const images = new Map<string, { title?: string }>();

  for (const image of [...(existing.images ?? []), ...(incoming.images ?? [])]) {
    if (image.title) {
      images.set(image.title, image);
    }
  }

  return {
    ...existing,
    ...incoming,
    images: images.size > 0 ? [...images.values()] : incoming.images ?? existing.images,
    imageinfo: incoming.imageinfo ?? existing.imageinfo,
  };
}

function getContinueParams(data: unknown): Record<string, string> | null {
  if (!isRecord(data) || !isRecord(data.continue)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(data.continue).map(([key, value]) => [key, String(value)]),
  );
}

function getMediaWikiError(data: unknown): { code: string; info?: string } | null {
  if (!isRecord(data) || !isRecord(data.error)) {
    return null;
  }

  const code = data.error.code;
  const info = data.error.info;

  return typeof code === "string"
    ? { code, info: typeof info === "string" ? info : undefined }
    : null;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string[]>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey ?? "";
    const value = rest.length > 0 ? rest.join("=") : "true";
    values.set(key, [...(values.get(key) ?? []), value]);
  }

  const email = getLast(values, "email") ?? getGitEmail();
  const languageId = getLanguageDataset(getLast(values, "language") ?? getLast(values, "lang")).id;
  const defaults = getLanguagePathDefaults(languageId);

  if (!email) {
    throw new Error("No email found. Set git config user.email or pass --email=you@example.com.");
  }

  return {
    languageId,
    words: splitList([...(values.get("word") ?? []), ...(values.get("words") ?? [])]),
    limit: parseOptionalInteger(getLast(values, "limit")),
    output: getLast(values, "output") ?? defaults.report,
    markdown: values.has("no-markdown")
      ? null
      : getLast(values, "markdown") ?? defaults.markdown,
    sourceWikis: parseSourceWikis(getLast(values, "wikis"), languageId),
    maxCandidatesPerWord: parseInteger(getLast(values, "max-candidates-per-word"), 8),
    delayMs: parseInteger(getLast(values, "delay-ms"), 150),
    retries: parseInteger(getLast(values, "retries"), 3),
    timeoutMs: parseInteger(getLast(values, "timeout-ms"), 30_000),
    email,
    download: parseDownloadMode(values),
    downloadDir: getLast(values, "download-dir") ?? defaults.downloadDir,
    reviewStatePath: getLast(values, "review-state") ?? defaults.reviewState,
    forceDownloadReviewed: values.has("force-download-reviewed"),
  };
}

function getLanguagePathDefaults(languageId: string): {
  report: string;
  markdown: string;
  downloadDir: string;
  reviewState: string;
} {
  const slug = getLanguageSlug(languageId);
  const reportPrefix = sameLanguageId(languageId, "fr") ? "wiktionary" : `${slug}-wiktionary`;

  return {
    report: `reports/${reportPrefix}-audio-candidates.json`,
    markdown: `reports/${reportPrefix}-audio-candidates.md`,
    downloadDir: `public/audio/${slug}/wiktionary`,
    reviewState: sameLanguageId(languageId, "fr")
      ? DEFAULT_REVIEW_STATE_PATH
      : `reports/${slug}-wiktionary-audio-review-state.json`,
  };
}

function selectWords(words: readonly WordEntry[], opts: CliOptions): WordEntry[] {
  const selected = opts.words.length > 0 ? selectRequestedWords(words, opts.words) : [...words];

  return opts.limit === null ? selected : selected.slice(0, opts.limit);
}

function selectRequestedWords(words: readonly WordEntry[], requests: readonly string[]): WordEntry[] {
  const exactRequests = new Set(requests.map(normalizeExactText));
  const exactMatches = words.filter((word) =>
    exactRequests.has(normalizeExactText(word.written)) || exactRequests.has(normalizeExactText(word.id))
  );
  const exactMatchIds = new Set(exactMatches.map((word) => word.id));
  const unresolvedRequests = requests.filter((request) =>
    !words.some((word) =>
      normalizeExactText(word.written) === normalizeExactText(request)
      || normalizeExactText(word.id) === normalizeExactText(request)
    )
  );
  const fallbackRequests = new Set(unresolvedRequests.map(normalizeSearchText));
  const fallbackMatches = words.filter((word) =>
    !exactMatchIds.has(word.id)
    && (fallbackRequests.has(normalizeSearchText(word.written)) || fallbackRequests.has(normalizeSearchText(word.id)))
  );

  return [...exactMatches, ...fallbackMatches];
}

function createUnambiguousFallbackTitleMap(words: readonly WordEntry[]): Map<string, WordEntry> {
  const candidates = new Map<string, WordEntry | null>();

  for (const word of words) {
    const key = normalizeSearchText(word.written);
    const existing = candidates.get(key);

    if (existing === undefined) {
      candidates.set(key, word);
    } else {
      candidates.set(key, null);
    }
  }

  return new Map(
    [...candidates.entries()].filter((entry): entry is [string, WordEntry] => entry[1] !== null),
  );
}

function createUserAgent(email: string): string {
  return `vowel_trowel-wiktionary-audio-scraper/0.1 (mailto:${email}; static language-learning audio candidate research)`;
}

function getGitEmail(): string | null {
  try {
    return execFileSync("git", ["config", "--get", "user.email"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function isAudioInfo(info: CommonsAudioInfo): boolean {
  return Boolean(info.mime?.startsWith(AUDIO_MIME_PREFIX) || isAudioFileTitle(info.fileTitle));
}

function isAudioFileTitle(title: string | undefined): title is string {
  if (!title) {
    return false;
  }

  const extension = title.split(".").pop()?.toLowerCase();

  return Boolean(extension && AUDIO_EXTENSIONS.has(extension));
}

function canonicalizeFileTitle(title: string): string {
  const fileTitle = title.replace(/^Fichier:/i, "File:").replace(/_/g, " ");
  const match = /^File:(.)(.*)$/.exec(fileTitle);

  return match?.[1] ? `File:${match[1].toUpperCase()}${match[2] ?? ""}` : fileTitle;
}

function hasFrenchLanguageMarker(haystack: string): boolean {
  return haystack.includes("q150")
    || /(^|[\s(])fra([\s)]|$)/.test(haystack)
    || /(^|\s)fr[-_]/.test(haystack)
    || haystack.includes("french")
    || haystack.includes("francais");
}

function hasEnglishLanguageMarker(haystack: string): boolean {
  return /(^|\s)en[-_](uk|gb|us|au|nz)(\s|[-_]|$)/.test(haystack)
    || /(^|[\s(])eng([\s)]|$)/.test(haystack)
    || haystack.includes("english")
    || haystack.includes("british");
}

function primaryWiktionaryHost(languageId: string): string {
  return sameLanguageId(languageId, "fr") ? "fr.wiktionary.org" : "en.wiktionary.org";
}

function detectRegions(haystack: string): string[] {
  const regions: string[] = [];
  const belgian = ["belgique", "belge", "belgian", "belgium", "wallonie", "wallon", "walloon", "bruxelles", "brussels", "fr-be"];
  const swiss = ["suisse", "swiss", "switzerland", "romand", "romande", "geneve", "genève", "vaud", "valais", "neuchatel", "neuchâtel", "fr-ch"];
  const british = ["british", "united kingdom", "uk", "england", "received pronunciation", "rp", "en-gb", "en-uk"];

  if (belgian.some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
    regions.push("Belgian French");
  }

  if (swiss.some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
    regions.push("Swiss French");
  }

  if (british.some((keyword) => haystack.includes(normalizeSearchText(keyword)))) {
    regions.push("British English");
  }

  return regions;
}

function renderMarkdown(report: AudioReport): string {
  const lines = [
    "# Wiktionary Audio Candidate Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Language: ${report.language.name} (${report.language.id})`,
    "",
    `User-Agent: \`${report.userAgent}\``,
    "",
    "## Summary",
    "",
    `- Words checked: ${report.summary.totalWords}`,
    `- Words with audio candidates: ${report.summary.wordsWithCandidates}`,
    `- Words with regional candidates: ${report.summary.wordsWithRegionalCandidates}`,
    `- Candidate files: ${report.summary.totalCandidates}`,
    `- Downloaded files: ${report.summary.downloadedCandidates}`,
    "",
    "## Candidates",
    "",
  ];

  for (const word of report.words) {
    lines.push(`### ${word.written} ${word.ipa}`);
    lines.push("");

    if (word.candidates.length === 0) {
      lines.push("No audio candidates found.");
      lines.push("");
      continue;
    }

    for (const candidate of word.candidates) {
      lines.push(`- ${candidate.fileTitle}`);
      lines.push(`  Source: ${candidate.commonsUrl}`);
      lines.push(`  License: ${candidate.licenseShortName ?? candidate.license ?? "unknown"}`);
      lines.push(`  Attribution: ${candidate.attribution ?? candidate.artist ?? candidate.credit ?? "unknown"}`);
      lines.push(`  Regions: ${candidate.regions.length ? candidate.regions.join(", ") : "none detected"}`);
      lines.push(`  Score: ${candidate.score} (${candidate.reasons.join("; ")})`);

      if (candidate.localPath) {
        lines.push(`  Local path: ${candidate.localPath}`);
      }

      if (candidate.metadataPath) {
        lines.push(`  Metadata: ${candidate.metadataPath}`);
      }

      if (candidate.datasetSrc) {
        lines.push(`  Dataset src: ${candidate.datasetSrc}`);
      }

      lines.push(`  Review: ${candidate.review.status}`);
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function printSummary(report: AudioReport, opts: CliOptions): void {
  console.log(`Checked ${report.summary.totalWords} ${report.language.name} words.`);
  console.log(`Found ${report.summary.totalCandidates} candidates for ${report.summary.wordsWithCandidates} words.`);
  console.log(`Regional candidates found for ${report.summary.wordsWithRegionalCandidates} words.`);
  console.log(`Wrote JSON report to ${opts.output}.`);

  if (opts.markdown) {
    console.log(`Wrote Markdown report to ${opts.markdown}.`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(filePath: string, value: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, value);
}

function parseDownloadMode(values: Map<string, string[]>): DownloadMode {
  if (!values.has("download")) {
    return "none";
  }

  const mode = getLast(values, "download");

  if (!mode || mode === "true") {
    return "regional";
  }

  if (mode === "all" || mode === "regional" || mode === "none") {
    return mode;
  }

  throw new Error(`Unknown download mode: ${mode}. Use --download=regional or --download=all.`);
}

function parseSourceWikis(value: string | undefined, languageId: string): SourceWiki[] {
  if (!value) {
    return sameLanguageId(languageId, "fr") ? DEFAULT_FRENCH_SOURCE_WIKIS : DEFAULT_ENGLISH_SOURCE_WIKIS;
  }

  const codes = splitList([value]);

  return codes.map((code) => {
    if (code === "fr") {
      return { code: "fr", host: "fr.wiktionary.org" };
    }

    if (code === "en") {
      return { code: "en", host: "en.wiktionary.org" };
    }

    throw new Error(`Unsupported wiki code: ${code}. Supported values: fr,en.`);
  });
}

function getLast(values: Map<string, string[]>, key: string): string | undefined {
  const entries = values.get(key);

  return entries ? entries[entries.length - 1] : undefined;
}

function splitList(values: readonly string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }

  return parsed;
}

function parseOptionalInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  return parseInteger(value, 0);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);

  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function backoffMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function normalizeExactText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripHtml(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim() || null;
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toDatasetAudioSrc(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  return normalized.startsWith("public/") ? normalized.slice("public/".length) : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
