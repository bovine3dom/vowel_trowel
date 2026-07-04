import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { strToU8, zipSync } from "fflate";

import {
  estimateLiveFormants,
  getAvailableSpeechVoices,
  getPlaybackVisualizationState,
  getPrecomputedSpectrogram,
  playAudioSources,
  playTermAudio,
  selectSpeechVoice,
  subscribePlaybackVisualization,
  type FormantTrack,
  type PrecomputedSpectrogram,
  type PlaybackVisualizationState,
} from "./audio/playback";
import {
  DEFAULT_CONTRIBUTION_TARGET_RECORDINGS as CONTRIBUTION_TARGET_RECORDINGS,
  createContributionQueue,
  contributionWordIdsForSpeaker,
  type ContributionQueueItem,
} from "./contributions/queue";
import { getLanguageDataset, getLanguageSlug, languageDatasets, sameLanguageId } from "./languages";
import type { AudioSource, LanguageDataset, MinimalPairTerm, Phoneme, PhonemeContrast, PhonemeId, WordEntry } from "./languages/types";
import {
  canSubmitPrompt,
  createMatchingPrompt,
  createPromptSelections,
  gradeMatchingPrompt,
  selectClosestWordPairsForPhonemes,
  selectNextMinimalPair,
  selectNextMinimalPairForPhonemes,
  type MatchingPrompt,
  type PromptResult,
  type PromptSelections,
  type PromptSlot,
} from "./training/session";
import {
  canSubmitSortingPrompt,
  createSortingPromptForPhonemes,
  createSortingPlacements,
  gradeSortingPrompt,
  selectNextSortingPrompt,
  type SortingGroup,
  type SortingPlacements,
  type SortingPrompt,
} from "./training/sort";
import {
  getLanguageProgress,
  getTopConfusions,
  loadProgress,
  recordPromptResult,
  resetProgress,
  saveProgress,
} from "./storage/progress";

const LAST_LANGUAGE_STORAGE_KEY = "vowel-trowel:last-language";
const dataset = getInitialDataset();
const SPEECH_VOICE_STORAGE_KEY = "vowel-trowel:tts-voice-uri";
const CONTRIBUTION_DETAILS_STORAGE_KEY = "vowel-trowel:contribution-details:v1";
const CONTRIBUTION_HISTORY_STORAGE_KEY = "vowel-trowel:contribution-history:v1";
const CONTRIBUTION_AUDIO_DEBUG_STORAGE_KEY = "vowel-trowel:debug-audio";
const CONTRIBUTION_SESSION_QUEUE_SIZE = 6;
const CONTRIBUTION_COUNTDOWN_SECONDS = 3;
const CONTRIBUTION_COUNTDOWN_DURATION_MS = CONTRIBUTION_COUNTDOWN_SECONDS * 1000;
const CONTRIBUTION_RECORDING_DURATION_MS = 2000;
const CONTRIBUTION_TIMELINE_DURATION_MS = CONTRIBUTION_COUNTDOWN_DURATION_MS + CONTRIBUTION_RECORDING_DURATION_MS;
const PHONEME_CARD_EXAMPLE_WORD_COUNT = 3;
const renderedSpectrograms = new WeakMap<PrecomputedSpectrogram, HTMLCanvasElement>();
type TrainingMode = "match" | "sort" | "target";
type CatalogTab = "phonemes" | "contrasts";
type PhonemePair = readonly [PhonemeId, PhonemeId];
type UrlHistoryMode = "push" | "replace";
type ContributionLicence = "CC0-1.0" | "CC-BY-4.0";
type ContributionDownloadStatus = "idle" | "downloading" | "downloaded";
type ContributionRecorderStatus = "idle" | "preparing" | "countdown" | "recording" | "recorded";

interface KeptContributionRecording {
  id: string;
  word: WordEntry;
  blob: Blob;
  mimeType: string;
  recordedAt: string;
}

interface ContributionBatchRecordingForManifest {
  id: string;
  word: WordEntry;
  filename: string;
  mimeType: string;
  recordingSize: number;
  recordedAt: string;
}

interface ContributionDetails {
  schemaVersion: 1;
  licence: ContributionLicence;
  speakerName: string;
  accent: string;
}

interface ContributionHistory {
  schemaVersion: 1;
  downloadedWordIds: string[];
}

interface UrlState {
  languageId: string;
  mode: TrainingMode;
  phonemePair: PhonemePair | null;
  catalogTab: CatalogTab;
  explorePhonemeId: PhonemeId | null;
  contributionWordId: string | null;
  contributionModeOpen: boolean;
  ttsEnabled: boolean;
  showUnrecordedPhonemes: boolean;
  hideSortWordNames: boolean;
}

interface AudioCredit {
  key: string;
  labels: string[];
  source: AudioSource;
}

export default function App() {
  const initialUrlState = readUrlState();
  const initialProgress = loadProgress();
  const initialPracticeDataset = createPracticeDataset(dataset, initialUrlState.ttsEnabled);
  const initialPrompt = createNextPrompt(initialProgress, initialUrlState.phonemePair, initialPracticeDataset);
  const initialSortingPrompt = createNextSortingPrompt(initialProgress, initialUrlState.phonemePair, initialPracticeDataset);
  const initialContributionDetails = loadContributionDetails();
  const initialActivePhonemePair = initialUrlState.phonemePair
    ?? (initialUrlState.mode === "sort"
      ? phonemePairFromSortingPrompt(initialSortingPrompt)
      : phonemePairFromMatchingPrompt(initialPrompt));
  const initialDraftPhonemeIds = initialUrlState.mode === "target"
    ? targetPracticeInitialPhonemeIds(dataset, initialUrlState.phonemePair ?? initialActivePhonemePair)
    : initialActivePhonemePair ?? [];
  const initialActiveSelection = initialUrlState.mode === "target"
    ? toPhonemePair(initialDraftPhonemeIds)
    : initialActivePhonemePair;
  const [mode, setMode] = createSignal<TrainingMode>(initialUrlState.mode);
  const [lockedPhonemePair, setLockedPhonemePair] = createSignal<PhonemePair | null>(initialUrlState.mode === "target" ? initialActiveSelection : initialUrlState.phonemePair);
  const [activePhonemePair, setActivePhonemePair] = createSignal<PhonemePair | null>(initialActiveSelection);
  const [draftPhonemeIds, setDraftPhonemeIds] = createSignal<readonly PhonemeId[]>(initialDraftPhonemeIds);
  const [catalogTab, setCatalogTab] = createSignal<CatalogTab>(initialUrlState.catalogTab);
  const [explorePhonemeId, setExplorePhonemeId] = createSignal<PhonemeId | null>(initialUrlState.explorePhonemeId);
  const [contributionWordId, setContributionWordId] = createSignal<string | null>(initialUrlState.contributionWordId);
  const [contributionModeOpen, setContributionModeOpen] = createSignal(initialUrlState.contributionModeOpen);
  const [ttsEnabled, setTtsEnabled] = createSignal(initialUrlState.ttsEnabled);
  const [showUnrecordedPhonemes, setShowUnrecordedPhonemes] = createSignal(initialUrlState.showUnrecordedPhonemes);
  const [hideSortWordNames, setHideSortWordNames] = createSignal(initialUrlState.hideSortWordNames);
  const [progress, setProgress] = createSignal(initialProgress);
  const [prompt, setPrompt] = createSignal<MatchingPrompt | undefined>(initialPrompt);
  const [selections, setSelections] = createSignal(createPromptSelections(initialPrompt));
  const [selectedSlotId, setSelectedSlotId] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<PromptResult | null>(null);
  const [sortingPrompt, setSortingPrompt] = createSignal<SortingPrompt | undefined>(initialSortingPrompt);
  const [sortingPlacements, setSortingPlacements] = createSignal(
    createSortingPlacements(initialSortingPrompt),
  );
  const [selectedSortingTermId, setSelectedSortingTermId] = createSignal<string | null>(null);
  const [draggedSortingTermId, setDraggedSortingTermId] = createSignal<string | null>(null);
  const [sortingResult, setSortingResult] = createSignal<PromptResult | null>(null);
  const [speechVoices, setSpeechVoices] = createSignal<SpeechSynthesisVoice[]>([]);
  const [selectedVoiceURI, setSelectedVoiceURI] = createSignal(loadSpeechVoiceURI());
  const [audioError, setAudioError] = createSignal<string | null>(null);
  const [playbackVisualization, setPlaybackVisualization] = createSignal(getPlaybackVisualizationState());
  const [downloadedContributionWordIds, setDownloadedContributionWordIds] = createSignal(loadDownloadedContributionWordIds());
  const [contributionSpeakerName, setContributionSpeakerName] = createSignal(initialContributionDetails.speakerName);

  const languageProgress = createMemo(() => getLanguageProgress(progress(), dataset.id));
  const practiceDataset = createMemo(() => createPracticeDataset(dataset, ttsEnabled()));
  const topConfusions = createMemo(() => getTopConfusions(progress(), dataset.id));
  const totalAttempts = createMemo(() => {
    const stats = languageProgress();
    return stats
      ? Object.values(stats.itemStats).reduce((total, item) => total + item.attempts, 0)
      : 0;
  });
  const speechSettings = createMemo(() => ({
    fallbackLang: dataset.defaultSpeechLang,
    preferredLangs: dataset.speechLangs,
    voiceURI: selectedVoiceURI(),
    ttsEnabled: ttsEnabled(),
  }));
  const languageSpeechVoices = createMemo(() =>
    speechVoices().filter((voice) =>
      (dataset.speechLangs ?? [dataset.defaultSpeechLang]).some((lang) => voiceMatchesSpeechLang(voice, lang))
    ),
  );
  const activeSpeechVoice = createMemo(() => selectSpeechVoice(speechVoices(), speechSettings()));
  const downloadedContributionWordIdSet = createMemo(() => new Set(downloadedContributionWordIds()));
  const speakerContributionWordIdSet = createMemo(() => contributionWordIdsForSpeaker(dataset, contributionSpeakerName()));
  const excludedContributionWordIdSet = createMemo(() => new Set([
    ...downloadedContributionWordIdSet(),
    ...speakerContributionWordIdSet(),
  ]));
  const contributionQueue = createMemo(() => createContributionQueue(dataset, excludedContributionWordIdSet()));
  const contributionWord = createMemo(() => {
    const wordId = contributionWordId();

    return wordId ? dataset.words.find((word) => word.id === wordId) : undefined;
  });
  const currentAudioCredits = createMemo(() => {
    if (contributionWordId() || contributionModeOpen()) {
      return [];
    }

    const exploredPhonemeId = explorePhonemeId();

    if (exploredPhonemeId) {
      return collectWordAudioCredits(wordsForPhoneme(exploredPhonemeId, practiceDataset()));
    }

    if (mode() === "target") {
      return [];
    }

    return mode() === "sort"
      ? collectTermAudioCredits(sortingPrompt()?.wordCards ?? [])
      : collectTermAudioCredits(prompt()?.item.terms ?? []);
  });

  onMount(() => {
    saveLastLanguageId(dataset.id);
    const refreshVoices = () => setSpeechVoices(getAvailableSpeechVoices());

    refreshVoices();

    if (!("speechSynthesis" in window)) {
      return;
    }

    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    onCleanup(() => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices));
  });

  onMount(() => {
    const unsubscribe = subscribePlaybackVisualization(setPlaybackVisualization);

    onCleanup(unsubscribe);
  });

  onMount(() => {
    const handlePopState = () => applyUrlState(readUrlState());

    window.addEventListener("popstate", handlePopState);
    onCleanup(() => window.removeEventListener("popstate", handlePopState));
  });

  const applyUrlState = (state: UrlState) => {
    const nextPracticeDataset = createPracticeDataset(dataset, state.ttsEnabled);
    const nextPrompt = createNextPrompt(progress(), state.phonemePair, nextPracticeDataset);
    const nextSortingPrompt = createNextSortingPrompt(progress(), state.phonemePair, nextPracticeDataset);
    const nextActivePair = state.phonemePair
      ?? (state.mode === "sort"
        ? phonemePairFromSortingPrompt(nextSortingPrompt)
        : phonemePairFromMatchingPrompt(nextPrompt));
    const nextDraftPhonemeIds = state.mode === "target"
      ? targetPracticeInitialPhonemeIds(dataset, state.phonemePair ?? nextActivePair)
      : nextActivePair ?? [];
    const nextActiveSelection = state.mode === "target"
      ? toPhonemePair(nextDraftPhonemeIds)
      : nextActivePair;

    setMode(state.mode);
    setLockedPhonemePair(state.mode === "target" ? nextActiveSelection : state.phonemePair);
    setActivePhonemePair(nextActiveSelection);
    setDraftPhonemeIds(nextDraftPhonemeIds);
    setCatalogTab(state.catalogTab);
    setExplorePhonemeId(state.explorePhonemeId);
    setContributionWordId(state.contributionWordId);
    setContributionModeOpen(state.contributionModeOpen);
    setTtsEnabled(state.ttsEnabled);
    setShowUnrecordedPhonemes(state.showUnrecordedPhonemes);
    setHideSortWordNames(state.hideSortWordNames);

    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setSelectedSlotId(null);
    setResult(null);
    setSortingPrompt(nextSortingPrompt);
    setSortingPlacements(createSortingPlacements(nextSortingPrompt));
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
  };

  const updateUrl = (patch: Partial<UrlState>, historyMode: UrlHistoryMode = "push") => {
    writeUrlState({
      languageId: dataset.id,
      mode: patch.mode ?? mode(),
      phonemePair: patch.phonemePair === undefined ? activePhonemePair() : patch.phonemePair,
      catalogTab: patch.catalogTab ?? catalogTab(),
      explorePhonemeId: patch.explorePhonemeId === undefined ? explorePhonemeId() : patch.explorePhonemeId,
      contributionWordId: patch.contributionWordId === undefined ? contributionWordId() : patch.contributionWordId,
      contributionModeOpen: patch.contributionModeOpen ?? contributionModeOpen(),
      ttsEnabled: patch.ttsEnabled ?? ttsEnabled(),
      showUnrecordedPhonemes: patch.showUnrecordedPhonemes ?? showUnrecordedPhonemes(),
      hideSortWordNames: patch.hideSortWordNames ?? hideSortWordNames(),
    }, historyMode);
  };

  onMount(() => updateUrl({ phonemePair: activePhonemePair() }, "replace"));

  const chooseMode = (nextMode: TrainingMode) => {
    if (nextMode === "target") {
      const nextDraft = targetPracticeInitialPhonemeIds(dataset, toPhonemePair(draftPhonemeIds()) ?? activePhonemePair());
      const nextPair = toPhonemePair(nextDraft);

      setMode(nextMode);
      setDraftPhonemeIds(nextDraft);
      setLockedPhonemePair(nextPair);
      setActivePhonemePair(nextPair);
      updateUrl({ mode: nextMode, phonemePair: nextPair });
      return;
    }

    setMode(nextMode);
    updateUrl({ mode: nextMode });
  };

  const chooseCatalogTab = (nextTab: CatalogTab) => {
    const nextExplorePhonemeId = nextTab === "phonemes" ? explorePhonemeId() : null;

    setCatalogTab(nextTab);
    setExplorePhonemeId(nextExplorePhonemeId);
    updateUrl({ catalogTab: nextTab, explorePhonemeId: nextExplorePhonemeId });
  };

  const explorePhoneme = (phonemeId: PhonemeId) => {
    setCatalogTab("phonemes");
    setExplorePhonemeId(phonemeId);
    setContributionWordId(null);
    updateUrl({ catalogTab: "phonemes", explorePhonemeId: phonemeId });
  };

  const closePhonemeExplorer = () => {
    setExplorePhonemeId(null);
    updateUrl({ explorePhonemeId: null }, "replace");
  };

  const openContributionPage = (word: WordEntry) => {
    setContributionWordId(word.id);
    setContributionModeOpen(false);
    updateUrl({ contributionWordId: word.id, contributionModeOpen: false });
  };

  const closeContributionPage = () => {
    setContributionWordId(null);
    updateUrl({ contributionWordId: null }, "replace");
  };

  const openContributionMode = () => {
    setContributionWordId(null);
    setContributionModeOpen(true);
    updateUrl({ contributionWordId: null, contributionModeOpen: true });
  };

  const closeContributionMode = () => {
    setContributionModeOpen(false);
    updateUrl({ contributionModeOpen: false }, "replace");
  };

  const toggleUnrecordedPhonemes = (nextShowUnrecordedPhonemes: boolean) => {
    setShowUnrecordedPhonemes(nextShowUnrecordedPhonemes);
    updateUrl({ showUnrecordedPhonemes: nextShowUnrecordedPhonemes }, "replace");
  };

  const toggleSortWordNames = (nextHideSortWordNames: boolean) => {
    setHideSortWordNames(nextHideSortWordNames);
    updateUrl({ hideSortWordNames: nextHideSortWordNames }, "replace");
  };

  const markContributionWordsDownloaded = (wordIds: readonly string[]) => {
    const nextWordIds = mergeDownloadedContributionWordIds(downloadedContributionWordIds(), wordIds);

    setDownloadedContributionWordIds(nextWordIds);
    saveDownloadedContributionWordIds(nextWordIds);
  };

  const selectPhonemeForDraft = (phonemeId: PhonemeId) => {
    const current = draftPhonemeIds();
    const nextDraft = mode() === "target"
      ? current.includes(phonemeId)
        ? current.length === 1
          ? current
          : current.filter((candidate) => candidate !== phonemeId)
        : current.length >= 2
          ? [current[1] ?? phonemeId, phonemeId]
          : [...current, phonemeId]
      : current.includes(phonemeId)
        ? current.filter((candidate) => candidate !== phonemeId)
        : current.length >= 2
          ? [phonemeId]
          : [...current, phonemeId];

    setDraftPhonemeIds(nextDraft);

    const nextPair = toPhonemePair(nextDraft);

    if (nextPair) {
      choosePhonemePair(nextPair);
    } else if (mode() === "target") {
      setLockedPhonemePair(null);
      setActivePhonemePair(null);
      updateUrl({ phonemePair: null }, "replace");
    }
  };

  const choosePhonemePair = (phonemePair: PhonemePair, nextMode = mode()) => {
    const nextPrompt = createNextPrompt(progress(), phonemePair, practiceDataset());
    const nextSortingPrompt = createNextSortingPrompt(progress(), phonemePair, practiceDataset());

    setMode(nextMode);
    setLockedPhonemePair(phonemePair);
    setActivePhonemePair(phonemePair);
    setDraftPhonemeIds(phonemePair);
    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setSelectedSlotId(null);
    setResult(null);
    setSortingPrompt(nextSortingPrompt);
    setSortingPlacements(createSortingPlacements(nextSortingPrompt));
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
    updateUrl({ mode: nextMode, phonemePair });
  };

  const clearPhonemePair = () => {
    const nextPrompt = createNextPrompt(progress(), null, practiceDataset());
    const nextSortingPrompt = createNextSortingPrompt(progress(), null, practiceDataset());
    const nextActivePair = mode() === "sort"
      ? phonemePairFromSortingPrompt(nextSortingPrompt)
      : phonemePairFromMatchingPrompt(nextPrompt);

    setLockedPhonemePair(null);
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setSelectedSlotId(null);
    setResult(null);
    setSortingPrompt(nextSortingPrompt);
    setSortingPlacements(createSortingPlacements(nextSortingPrompt));
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
    updateUrl({ phonemePair: nextActivePair }, "replace");
  };

  const playRandomWordRecording = async (word: WordEntry) => {
    const source = chooseRandomAudioSource(word.audio);

    setAudioError(null);

    try {
      await playAudioSources(
        source ? [source] : [],
        word.speechText ?? word.written,
        speechSettings(),
        undefined,
        getAudioFeedbackPath(source),
      );
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const playWordTts = async (word: WordEntry) => {
    setAudioError(null);

    try {
      await playAudioSources([], word.speechText ?? word.written, speechSettings());
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const playAudioTrack = async (word: WordEntry, source: AudioSource) => {
    setAudioError(null);

    try {
      await playAudioSources(
        [source],
        word.speechText ?? word.written,
        speechSettings(),
        undefined,
        getAudioFeedbackPath(source),
      );
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const selectSound = async (slot: PromptSlot) => {
    if (!result()) {
      setSelectedSlotId(slot.id);
    }

    await playSlot(slot);
  };

  const chooseWord = (term: MinimalPairTerm) => {
    const slotId = selectedSlotId();

    if (result()) {
      return;
    }

    if (!slotId) {
      return;
    }

    setSelections((current) => {
      const nextSelections = { ...current };
      const alreadyMatched = current[slotId] === term.id;

      for (const currentSlotId of Object.keys(nextSelections)) {
        if (nextSelections[currentSlotId] === term.id) {
          nextSelections[currentSlotId] = null;
        }
      }

      nextSelections[slotId] = alreadyMatched ? null : term.id;
      return nextSelections;
    });
    setSelectedSlotId(null);
  };

  const playSlot = async (slot: PromptSlot) => {
    setAudioError(null);

    try {
      await playTermAudio(
        slot.term,
        speechSettings(),
        `Sample ${slot.label}`,
        getAudioFeedbackPath(selectedAudioForTerm(slot.term)),
      );
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const submit = () => {
    const activePrompt = prompt();

    if (!activePrompt || !canSubmitPrompt(selections(), activePrompt)) {
      return;
    }

    const graded = gradeMatchingPrompt(dataset.id, activePrompt, selections());

    if (!graded) {
      return;
    }

    const nextProgress = recordPromptResult(progress(), graded);
    saveProgress(nextProgress);
    setProgress(nextProgress);
    setResult(graded);
  };

  const playMatchingAgain = () => {
    const currentPair = phonemePairFromMatchingPrompt(prompt()) ?? activePhonemePair();
    const nextPrompt = createNextPrompt(progress(), currentPair, practiceDataset());
    const nextActivePair = currentPair ?? phonemePairFromMatchingPrompt(nextPrompt);

    setLockedPhonemePair(currentPair);
    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setSelectedSlotId(null);
    setResult(null);
    setAudioError(null);
    updateUrl({ phonemePair: nextActivePair }, "replace");
  };

  const nextMatchingContrast = () => {
    const nextPrompt = createNextPrompt(progress(), null, practiceDataset());
    const nextActivePair = phonemePairFromMatchingPrompt(nextPrompt);

    setLockedPhonemePair(null);
    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setSelectedSlotId(null);
    setResult(null);
    setAudioError(null);
    updateUrl({ phonemePair: nextActivePair }, "replace");
  };

  const selectSortingWord = async (term: MinimalPairTerm) => {
    if (!sortingResult()) {
      setSelectedSortingTermId(term.id);
    }

    await playSortingWord(term);
  };

  const playSortingWord = async (term: MinimalPairTerm) => {
    setAudioError(null);

    try {
      await playTermAudio(
        term,
        speechSettings(),
        hideSortWordNames() ? sortingSampleLabel(sortingPrompt(), term) : undefined,
        getAudioFeedbackPath(selectedAudioForTerm(term)),
      );
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const placeSortingWord = (termId: string, phonemeId: PhonemeId | null) => {
    if (sortingResult()) {
      return;
    }

    setSortingPlacements((current) => ({ ...current, [termId]: phonemeId }));
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
  };

  const placeSelectedSortingWord = (phonemeId: PhonemeId | null) => {
    const termId = selectedSortingTermId() ?? draggedSortingTermId();

    if (!termId) {
      return;
    }

    placeSortingWord(termId, phonemeId);
  };

  const submitSorting = () => {
    const activePrompt = sortingPrompt();

    if (!activePrompt || !canSubmitSortingPrompt(sortingPlacements(), activePrompt)) {
      return;
    }

    const graded = gradeSortingPrompt(dataset.id, activePrompt, sortingPlacements());

    if (!graded) {
      return;
    }

    const nextProgress = recordPromptResult(progress(), graded);
    saveProgress(nextProgress);
    setProgress(nextProgress);
    setSortingResult(graded);
  };

  const playSortingAgain = () => {
    const currentPair = phonemePairFromSortingPrompt(sortingPrompt()) ?? activePhonemePair();
    const nextPrompt = createNextSortingPrompt(progress(), currentPair, practiceDataset());
    const nextActivePair = currentPair ?? phonemePairFromSortingPrompt(nextPrompt);

    setLockedPhonemePair(currentPair);
    setSortingPrompt(nextPrompt);
    setSortingPlacements(createSortingPlacements(nextPrompt));
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
    updateUrl({ phonemePair: nextActivePair }, "replace");
  };

  const nextSortingContrast = () => {
    const nextPrompt = createNextSortingPrompt(progress(), null, practiceDataset());
    const nextActivePair = phonemePairFromSortingPrompt(nextPrompt);

    setLockedPhonemePair(null);
    setSortingPrompt(nextPrompt);
    setSortingPlacements(createSortingPlacements(nextPrompt));
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
    updateUrl({ phonemePair: nextActivePair }, "replace");
  };

  const playSortingGroup = async (group: SortingGroup) => {
    const phoneme = dataset.phonemes.find((candidate) => candidate.id === group.phonemeId);

    setAudioError(null);

    try {
      if (phoneme?.audio?.length) {
        await playAudioSources(phoneme.audio, group.label, speechSettings());
        return;
      }

      await playTermAudio(
        group.exampleTerm,
        speechSettings(),
        undefined,
        getAudioFeedbackPath(selectedAudioForTerm(group.exampleTerm)),
      );
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const clearProgress = () => {
    if (!window.confirm("Reset all local training progress?")) {
      return;
    }

    const emptyProgress = resetProgress();
    const nextPrompt = createNextPrompt(emptyProgress, lockedPhonemePair(), practiceDataset());
    const nextSortingPrompt = createNextSortingPrompt(emptyProgress, lockedPhonemePair(), practiceDataset());

    setProgress(emptyProgress);
    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setSortingPrompt(nextSortingPrompt);
    setSortingPlacements(createSortingPlacements(nextSortingPrompt));
    setSelectedSlotId(null);
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setResult(null);
    setSortingResult(null);
  };

  const chooseSpeechVoice = (voiceURI: string) => {
    const nextVoiceURI = voiceURI || null;

    setSelectedVoiceURI(nextVoiceURI);
    saveSpeechVoiceURI(nextVoiceURI);
  };

  const chooseLanguage = (languageId: string) => {
    if (sameLanguageId(languageId, dataset.id) || typeof window === "undefined") {
      return;
    }

    saveLastLanguageId(languageId);
    const params = new URLSearchParams(window.location.search);
    params.set("lang", languageId);
    params.delete("phonemes");
    params.delete("explore");
    params.delete("contribute");

    const query = params.toString();
    window.location.assign(`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  };

  return (
    <main class="app-shell">
      <section class="hero-panel">
        <div>
          <p class="eyebrow">Listen and compare</p>
          <h1>Vowel Trowel</h1>
          <p class="hero-copy">
            Hear two words, choose what you heard, and practise the sounds that trip you up.
          </p>
        </div>
        <div class="language-card">
          <select
            aria-label="Language"
            class="language-select"
            value={dataset.id}
            onInput={(event) => chooseLanguage(event.currentTarget.value)}
          >
            <For each={languageDatasets}>
              {(language) => <option value={language.id}>{language.name}</option>}
            </For>
          </select>
        </div>
      </section>

      <Show
        when={contributionModeOpen()}
        fallback={
          <Show
            when={contributionWord()}
            fallback={
              <>
      <nav class="mode-tabs" aria-label="Training mode">
        <button
          class={mode() === "match" ? "mode-tab selected" : "mode-tab"}
          type="button"
          onClick={() => chooseMode("match")}
        >
          Match sounds
        </button>
        <button
          class={mode() === "sort" ? "mode-tab selected" : "mode-tab"}
          type="button"
          onClick={() => chooseMode("sort")}
        >
          Sort words
        </button>
        <button
          class={mode() === "target" ? "mode-tab selected" : "mode-tab"}
          type="button"
          onClick={() => chooseMode("target")}
        >
          Target vowels
        </button>
      </nav>

      <section class="workspace-grid">
        <Show when={mode() === "target"} fallback={
          <Show when={mode() === "match"} fallback={
            <Show when={sortingPrompt()} fallback={<EmptyDataset />}>
              {(activePrompt) => (
                <SortingPanel
                  prompt={activePrompt()}
                  placements={sortingPlacements()}
                  selectedTermId={selectedSortingTermId()}
                  result={sortingResult()}
                  audioError={audioError()}
                  hideWordNames={hideSortWordNames()}
                  onWordClick={selectSortingWord}
                  onHideWordNamesChange={toggleSortWordNames}
                  onPlaceWord={placeSortingWord}
                  onPlaceSelected={placeSelectedSortingWord}
                  onGroupPlay={playSortingGroup}
                  onDragStart={setDraggedSortingTermId}
                  onDragEnd={() => setDraggedSortingTermId(null)}
                  onSubmit={submitSorting}
                  onPlayAgain={playSortingAgain}
                  onNextContrast={nextSortingContrast}
                />
              )}
            </Show>
          }>
            <Show when={prompt()} fallback={<EmptyDataset />}>
              {(activePrompt) => (
                <TrainingPanel
                  prompt={activePrompt()}
                  selections={selections()}
                  selectedSlotId={selectedSlotId()}
                  result={result()}
                  audioError={audioError()}
                  onSoundClick={selectSound}
                  onWordClick={chooseWord}
                  onSubmit={submit}
                  onPlayAgain={playMatchingAgain}
                  onNextContrast={nextMatchingContrast}
                />
              )}
            </Show>
          </Show>
        }>
          <TargetPracticePanel
            language={dataset}
            selectedPhonemeIds={draftPhonemeIds()}
            playbackVisualization={playbackVisualization()}
          />
        </Show>

        <aside class="progress-panel">
          <div class="panel-heading">
            <p class="eyebrow">Your progress</p>
            <h2>Practice history</h2>
          </div>
          <div class="stat-grid">
            <Metric label="Tries" value={String(totalAttempts())} />
            <Metric label="Sound pairs" value={String(dataset.contrasts.length)} />
          </div>
          <SpectrogramPanel visualization={playbackVisualization()} />
          <Show when={ttsEnabled()}>
            <VoicePanel
              voices={languageSpeechVoices()}
              activeVoice={activeSpeechVoice()}
              selectedVoiceURI={selectedVoiceURI()}
              languageName={dataset.name}
              preferredLangs={dataset.speechLangs ?? [dataset.defaultSpeechLang]}
              onSelect={chooseSpeechVoice}
            />
          </Show>
          <div class="confusion-list">
            <h3>Tricky sounds</h3>
            <Show
              when={topConfusions().length > 0}
              fallback={<p class="muted">Patterns will appear here as you practise.</p>}
            >
              <For each={topConfusions()}>
                {(confusion) => (
                  <div class="confusion-row">
                    <span>
                      <span class="ipa-text">{phonemeLabel(confusion.heardPhonemeId)}</span> {"->"}{" "}
                      <span class="ipa-text">{phonemeLabel(confusion.chosenPhonemeId)}</span>
                    </span>
                    <strong>{confusion.count}</strong>
                  </div>
                )}
              </For>
            </Show>
          </div>
          <button class="text-button" type="button" onClick={clearProgress}>
            Reset local progress
          </button>
        </aside>
      </section>

      <section class="content-panel">
        <div class="panel-heading">
          <p class="eyebrow">Explore sounds</p>
          <h2>{dataset.name} sound library</h2>
        </div>
        <CatalogPanel
          mode={mode()}
          tab={catalogTab()}
          activePhonemePair={activePhonemePair()}
          draftPhonemeIds={draftPhonemeIds()}
          explorePhonemeId={explorePhonemeId()}
          audioError={audioError()}
          availableDataset={practiceDataset()}
          ttsEnabled={ttsEnabled()}
          showUnrecordedPhonemes={showUnrecordedPhonemes()}
          onTabChange={chooseCatalogTab}
          onPhonemeSelect={selectPhonemeForDraft}
          onPhonemeExplore={explorePhoneme}
          onExploreClose={closePhonemeExplorer}
          onShowUnrecordedPhonemesChange={toggleUnrecordedPhonemes}
          onPairSelect={choosePhonemePair}
          onPairClear={clearPhonemePair}
          onRandomRecordingPlay={playRandomWordRecording}
          onWordTtsPlay={playWordTts}
          onTrackPlay={playAudioTrack}
          onContribute={openContributionPage}
        />
        <AudioCreditsPanel credits={currentAudioCredits()} ttsEnabled={ttsEnabled()} />
        <ContributionModeCallout queue={contributionQueue()} onStart={openContributionMode} />
      </section>

              </>
            }
          >
            {(word) => (
              <ContributionPage
                language={dataset}
                word={word()}
                onBack={closeContributionPage}
                onContributionDownloaded={markContributionWordsDownloaded}
                onContributionSpeakerNameChange={setContributionSpeakerName}
              />
            )}
          </Show>
        }
      >
        <ContributionModePage
          language={dataset}
          queue={contributionQueue()}
          onBack={closeContributionMode}
          onContributionDownloaded={markContributionWordsDownloaded}
          onContributionSpeakerNameChange={setContributionSpeakerName}
        />
      </Show>

      <footer class="app-footer">
        <a
          class="github-link"
          href="https://github.com/bovine3dom/vowel_trowel"
          target="_blank"
          rel="noreferrer"
          aria-label="View Vowel Trowel on GitHub"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.38 7.86 10.9.58.11.79-.25.79-.56v-2.15c-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .98-.31 3.17 1.18A10.9 10.9 0 0 1 12 6.05c.98 0 1.96.13 2.88.39 2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.11 3.04.74.8 1.18 1.83 1.18 3.08 0 4.42-2.69 5.39-5.26 5.67.42.36.78 1.06.78 2.14v3.15c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
          </svg>
          made by bovine3dom. view source on github
        </a>
      </footer>
    </main>
  );
}

function TrainingPanel(props: {
  prompt: MatchingPrompt;
  selections: PromptSelections;
  selectedSlotId: string | null;
  result: PromptResult | null;
  audioError: string | null;
  onSoundClick: (slot: PromptSlot) => void;
  onWordClick: (term: MinimalPairTerm) => void;
  onSubmit: () => void;
  onPlayAgain: () => void;
  onNextContrast: () => void;
}) {
  const contrast = createMemo(() =>
    dataset.contrasts.find((candidate) => candidate.id === props.prompt.item.contrastId),
  );
  const heading = createMemo(() =>
    contrast()?.label ?? phonemeIdsLabel(props.prompt.item.terms.map((term) => term.phonemeId)),
  );
  const selectedSlot = createMemo(() =>
    props.prompt.slots.find((slot) => slot.id === props.selectedSlotId),
  );

  return (
    <section class="training-panel">
      <div class="panel-heading">
        <p class="eyebrow">Listen for</p>
        <h2 class="ipa-heading">{heading()}</h2>
      </div>
      <p class="instructions">
        Play each sample, then choose the word you heard.
      </p>
      <p class="interaction-hint">
        <Show
          when={selectedSlot()}
          fallback="Choose a sound from the left column."
        >
          {(slot) => <>Choose a word for Sample {slot().label}.</>}
        </Show>
      </p>

      <Show when={props.audioError}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <div class="match-board">
        <div class="match-column">
          <div class="column-title">
            <h3>Sounds</h3>
            <span>Tap to play and select</span>
          </div>
          <For each={props.prompt.displaySlots}>
            {(slot) => {
              const assignedTerm = () => getAssignedTermForSlot(props.prompt, props.selections, slot);

              return (
                <button
                  class={soundButtonClass(
                    slot,
                    props.prompt,
                    props.selections,
                    props.result,
                    props.selectedSlotId,
                  )}
                  type="button"
                  onClick={() => props.onSoundClick(slot)}
                >
                  <span class="sample-label">Sample {slot.label}</span>
                  <span class="sample-meta">
                    {slot.term.word.audio.length ? "Recording" : "Browser voice"}
                  </span>
                  <span class="assignment-line">
                    <Show
                      when={assignedTerm()}
                      fallback={
                        props.selectedSlotId === slot.id ? "Choose a word" : "No word selected"
                      }
                    >
                      {(term) => (
                        <>
                          Matched to {term().word.written} <span>{term().word.ipa}</span>
                        </>
                      )}
                    </Show>
                  </span>
                </button>
              );
            }}
          </For>
        </div>

        <div class="match-column">
          <div class="column-title">
            <h3>Words</h3>
            <span>Tap after selecting a sound</span>
          </div>
          <For each={props.prompt.wordCards}>
            {(term) => {
              const assignedSlot = () => getAssignedSlotForTerm(props.prompt, props.selections, term);

              return (
                <button
                  class={wordButtonClass(
                    term,
                    props.prompt,
                    props.selections,
                    props.result,
                    props.selectedSlotId,
                  )}
                  type="button"
                  onClick={() => props.onWordClick(term)}
                  disabled={Boolean(props.result)}
                >
                  <span class="word-text">{term.word.written}</span>
                  <span class="word-ipa">{term.word.ipa}</span>
                  <small>
                    <Show
                      when={assignedSlot()}
                      fallback={props.selectedSlotId ? "Tap to match" : "Select a sound first"}
                    >
                      {(slot) => <>Matched to Sample {slot().label}</>}
                    </Show>
                  </small>
                </button>
              );
            }}
          </For>
        </div>
      </div>

      <Show when={props.result}>
        {(graded) => (
          <div class={graded().correct ? "result-card correct" : "result-card incorrect"}>
            <strong>{graded().correct ? "Correct" : "Not quite"}</strong>
            <For each={graded().answers}>
              {(answer) => {
                const slot = props.prompt.slots.find((candidate) => candidate.id === answer.slotId);
                const chosen = props.prompt.item.terms.find((candidate) => candidate.id === answer.chosenTermId);

                return (
                  <p>
                    Sample {slot?.label}: heard {slot?.term.word.written}{" "}
                    <span class="ipa-text">{slot?.term.word.ipa}</span>, chose {chosen?.word.written}{" "}
                    <span class="ipa-text">{chosen?.word.ipa}</span>
                  </p>
                );
              }}
            </For>
          </div>
        )}
      </Show>

      <div class="action-row">
        <Show
          when={props.result}
          fallback={
            <button
              class="primary-button"
              type="button"
              onClick={props.onSubmit}
              disabled={!canSubmitPrompt(props.selections, props.prompt)}
            >
              Check answer
            </button>
          }
        >
          <button class="primary-button secondary" type="button" onClick={props.onPlayAgain}>
            New pair
          </button>
          <button class="primary-button" type="button" onClick={props.onNextContrast}>
            Next contrast
          </button>
        </Show>
      </div>
    </section>
  );
}

function SortingPanel(props: {
  prompt: SortingPrompt;
  placements: SortingPlacements;
  selectedTermId: string | null;
  result: PromptResult | null;
  audioError: string | null;
  hideWordNames: boolean;
  onWordClick: (term: MinimalPairTerm) => void;
  onHideWordNamesChange: (hideWordNames: boolean) => void;
  onPlaceWord: (termId: string, phonemeId: PhonemeId | null) => void;
  onPlaceSelected: (phonemeId: PhonemeId | null) => void;
  onGroupPlay: (group: SortingGroup) => void;
  onDragStart: (termId: string) => void;
  onDragEnd: () => void;
  onSubmit: () => void;
  onPlayAgain: () => void;
  onNextContrast: () => void;
}) {
  const contrast = createMemo(() =>
    dataset.contrasts.find((candidate) => candidate.id === props.prompt.contrastId),
  );
  const heading = createMemo(() =>
    contrast()?.label ?? phonemeIdsLabel(props.prompt.groups.map((group) => group.phonemeId)),
  );
  const selectedTerm = createMemo(() =>
    props.prompt.wordCards.find((term) => term.id === props.selectedTermId),
  );
  const unplacedTerms = () =>
    props.prompt.wordCards.filter((term) => !props.placements[term.id]);
  const termsForGroup = (group: SortingGroup) =>
    props.prompt.wordCards.filter((term) => props.placements[term.id] === group.phonemeId);
  const dropOnGroup = (event: DragEvent, phonemeId: PhonemeId | null) => {
    event.preventDefault();
    const termId = event.dataTransfer?.getData("text/plain");

    if (termId) {
      props.onPlaceWord(termId, phonemeId);
    }
  };

  return (
    <section class="training-panel">
      <div class="panel-heading">
        <p class="eyebrow">Sort words</p>
        <h2 class="ipa-heading">{heading()}</h2>
      </div>
      <p class="instructions">
        Put each word under the sound it contains. Tap a word to hear it; tap a sound heading
        to hear an example.
      </p>
      <label class="sort-option">
        <input
          type="checkbox"
          checked={props.hideWordNames}
          onInput={(event) => props.onHideWordNamesChange(event.currentTarget.checked)}
        />
        Hide word names
      </label>
      <p class="interaction-hint">
        <Show when={selectedTerm()} fallback="Tap or drag a word from the bag.">
          {(term) => <>Selected {sortingWordCardLabel(props.prompt, term(), props.hideWordNames)}. Choose a sound group.</>}
        </Show>
      </p>

      <Show when={props.audioError}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <div class="sort-groups">
        <For each={props.prompt.groups}>
          {(group) => (
            <section
              class={sortGroupClass(props.prompt, group, props.selectedTermId, props.result)}
              data-phoneme={group.phonemeId}
              onClick={() => props.onPlaceSelected(group.phonemeId)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropOnGroup(event, group.phonemeId)}
            >
              <button
                class="sort-group-title"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onGroupPlay(group);
                }}
              >
                <span class="ipa-text">{group.label}</span>
                <small>{phonemeHasAudio(group.phonemeId) ? "Play sound" : "Play example"}</small>
              </button>
              <div class="sort-word-grid">
                <Show
                  when={termsForGroup(group).length > 0}
                  fallback={<p class="muted">Drop words here.</p>}
                >
                  <For each={termsForGroup(group)}>
                    {(term) => (
                      <SortWordCard
                        term={term}
                        prompt={props.prompt}
                        placements={props.placements}
                        selectedTermId={props.selectedTermId}
                        result={props.result}
                        showIpa={Boolean(props.result)}
                        hideWordName={props.hideWordNames}
                        onWordClick={props.onWordClick}
                        onDragStart={props.onDragStart}
                        onDragEnd={props.onDragEnd}
                      />
                    )}
                  </For>
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>

      <section
        class="sort-bag"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropOnGroup(event, null)}
      >
        <div class="column-title">
          <h3>Word bag</h3>
          <span>{props.hideWordNames ? "Names hidden; samples play the words" : "Pronunciation appears after checking"}</span>
        </div>
        <div class="sort-word-grid">
          <Show when={unplacedTerms().length > 0} fallback={<p class="muted">All words placed.</p>}>
            <For each={unplacedTerms()}>
              {(term) => (
                <SortWordCard
                  term={term}
                  prompt={props.prompt}
                  placements={props.placements}
                  selectedTermId={props.selectedTermId}
                  result={props.result}
                  showIpa={Boolean(props.result)}
                  hideWordName={props.hideWordNames}
                  onWordClick={props.onWordClick}
                  onDragStart={props.onDragStart}
                  onDragEnd={props.onDragEnd}
                />
              )}
            </For>
          </Show>
        </div>
      </section>


      <Show when={props.result}>
        {(graded) => (
          <div class={graded().correct ? "result-card correct" : "result-card incorrect"}>
            <strong>{graded().correct ? "Correct" : "Not quite"}</strong>
            <For each={graded().answers}>
              {(answer) => {
                const term = props.prompt.wordCards.find(
                  (candidate) => candidate.id === answer.heardTermId,
                );

                return (
                  <p>
                    {term?.word.written}: <span class="ipa-text">{phonemeLabel(answer.heardPhonemeId)}</span>{" "}
                    word placed under <span class="ipa-text">{phonemeLabel(answer.chosenPhonemeId)}</span>
                  </p>
                );
              }}
            </For>
          </div>
        )}
      </Show>

      <div class="action-row">
        <Show
          when={props.result}
          fallback={
            <button
              class="primary-button"
              type="button"
              onClick={props.onSubmit}
              disabled={!canSubmitSortingPrompt(props.placements, props.prompt)}
            >
              Check answer
            </button>
          }
        >
          <button class="small-button" type="button" onClick={props.onPlayAgain}>
            Play again
          </button>
          <button class="primary-button" type="button" onClick={props.onNextContrast}>
            Next contrast
          </button>
        </Show>
      </div>
    </section>
  );
}

function SortWordCard(props: {
  term: MinimalPairTerm;
  prompt: SortingPrompt;
  placements: SortingPlacements;
  selectedTermId: string | null;
  result: PromptResult | null;
  showIpa: boolean;
  hideWordName: boolean;
  onWordClick: (term: MinimalPairTerm) => void;
  onDragStart: (termId: string) => void;
  onDragEnd: () => void;
}) {
  return (
    <button
      class={sortWordCardClass(
        props.term,
        props.prompt,
        props.placements,
        props.result,
        props.selectedTermId,
      )}
      data-phoneme={props.term.phonemeId}
      type="button"
      draggable={!props.result}
      onClick={(event) => {
        event.stopPropagation();
        props.onWordClick(props.term);
      }}
      onDragStart={(event) => {
        event.dataTransfer?.setData("text/plain", props.term.id);
        props.onDragStart(props.term.id);
      }}
      onDragEnd={props.onDragEnd}
    >
      <span class="word-text">{sortingWordCardLabel(props.prompt, props.term, props.hideWordName)}</span>
      <Show when={props.showIpa}>
        <span class="word-ipa">{props.term.word.ipa}</span>
      </Show>
    </button>
  );
}

type LiveFormantTrackerStatus = "idle" | "starting" | "listening" | "error";

interface TargetPracticeVowel extends FormantTarget {
  name: string;
  audio: readonly AudioSource[];
}

type TargetPracticeSelectionId = `vowel:${string}` | `pair:${string}`;

const LIVE_FORMANT_FRAME_SECONDS = 0.04;
const LIVE_FORMANT_ANALYSIS_HOP_MS = 25;
const LIVE_FORMANT_TRAIL_SECONDS = 2.4;
const LIVE_FORMANT_DISPLAY_MAX_HZ = 4000;

function TargetPracticePanel(props: {
  language: LanguageDataset;
  selectedPhonemeIds: readonly PhonemeId[];
  playbackVisualization: PlaybackVisualizationState;
}) {
  const tracker = createLiveFormantTracker();
  const targets = createMemo(() => targetPracticeVowelsForLanguage(props.language));
  const [selectedPracticeId, setSelectedPracticeId] = createSignal<TargetPracticeSelectionId | null>(null);
  const [exampleSpectrogram, setExampleSpectrogram] = createSignal<PrecomputedSpectrogram | null>(null);
  const [exampleLabel, setExampleLabel] = createSignal<string | null>(null);
  const [exampleError, setExampleError] = createSignal<string | null>(null);
  const [exampleProgress, setExampleProgress] = createSignal(0);
  const selectedTargets = createMemo((): TargetPracticeVowel[] =>
    props.selectedPhonemeIds
      .slice(0, 2)
      .flatMap((targetId, index): TargetPracticeVowel[] => {
        const target = targets().find((candidate) => candidate.id === targetId);

        return target
          ? [{ ...target, style: formantContrastTargetStyle(index) }]
          : [];
      })
  );
  const selectedTarget = createMemo(() => selectedTargets()[0]);
  const selectedTargetPair = createMemo((): PhonemePair | null => {
    const selected = selectedTargets();
    const first = selected[0]?.id;
    const second = selected[1]?.id;

    return first && second ? [first, second] : null;
  });
  const contrastWordPairs = createMemo(() => {
    const pair = selectedTargetPair();

    return pair ? selectClosestWordPairsForPhonemes(props.language, pair, 8) : [];
  });
  const selectedPracticePair = createMemo(() => {
    const practiceId = selectedPracticeId();

    if (!practiceId?.startsWith("pair:")) {
      return undefined;
    }

    return contrastWordPairs().find((pair) => `pair:${pair.id}` === practiceId);
  });
  const selectedTargetWords = createMemo(() => {
    const target = selectedTarget();

    return target && selectedTargets().length === 1
      ? props.language.words.filter((word) => word.phonemeIds.includes(target.id))
      : [];
  });
  const selectedTargetPaths = createMemo(() => {
    const pair = selectedPracticePair();
    const selected = selectedTargets();

    if (pair) {
      return pair.terms
        .map((term) => {
          const targetIndex = selected.findIndex((target) => target.id === term.phonemeId);

          return formantTargetPathForWord(
            term.word,
            props.language,
            formantContrastWordStyle(targetIndex >= 0 ? targetIndex : 0),
          );
        })
        .filter((path): path is FormantTargetPath => Boolean(path));
    }

    return [];
  });
  const selectedPracticeLabel = createMemo(() => {
    const pair = selectedPracticePair();

    if (pair) {
      return pair.terms.map((term) => `"${term.word.written}"`).join(" and ");
    }

    const selected = selectedTargets();

    return selected.length > 1
      ? `the ${selected.map((target) => target.label).join(" and ")} sounds`
      : selected[0]
        ? `the ${selected[0].label} sound`
        : "the selected sound";
  });
  const selectedExampleWords = createMemo((): WordEntry[] => {
    const pair = selectedPracticePair();

    if (pair) {
      return pair.terms.map((term) => term.word);
    }

    return [];
  });
  const selectedExampleAvailable = createMemo(() => {
    return selectedExampleWords().some((word) => word.audio.length > 0)
      || selectedTargetWords().some((word) => word.audio.length > 0);
  });
  const microphoneStatusText = createMemo(() => {
    if (tracker.status() === "starting") {
      return "Starting";
    }

    if (tracker.status() === "listening") {
      return "Listening";
    }

    if (tracker.status() === "error") {
      return "Needs attention";
    }

    return "Off";
  });
  const statusText = createMemo(() => {
    if (tracker.status() === "starting") {
      return "Opening microphone...";
    }

    if (tracker.status() === "listening") {
      const point = tracker.latest();

      if (point && point.f1 !== null && point.f2 !== null) {
        return "Your voice is on the chart. Keep the sound steady and move toward the target.";
      }

      return "Listening. Make the selected sound and hold it steady.";
    }

    return "Pick one or two vowel sounds below, then start the microphone when you are ready.";
  });

  createEffect(() => {
    const selected = selectedTargets();
    const practiceId = selectedPracticeId();

    if (selected.length === 0) {
      setSelectedPracticeId(null);
      return;
    }

    if (selected.length === 2) {
      const pairs = contrastWordPairs();

      if (!practiceId?.startsWith("pair:") || !pairs.some((pair) => `pair:${pair.id}` === practiceId)) {
        setSelectedPracticeId(pairs[0] ? `pair:${pairs[0].id}` : null);
      }

      return;
    }

    const target = selected[0];

    if (!target) {
      return;
    }

    if (
      !practiceId
      || practiceId.startsWith("pair:")
    ) {
      setSelectedPracticeId(`vowel:${target.id}`);
    }
  });

  createEffect(() => {
    selectedPracticeId();
    setExampleSpectrogram(null);
    setExampleLabel(null);
    setExampleError(null);
    setExampleProgress(0);
  });

  createEffect(() => {
    const visualization = props.playbackVisualization;
    const label = exampleLabel();

    if (!label || visualization.label !== label) {
      return;
    }

    let frame: number | undefined;
    const tick = () => {
      const timing = visualization.getTiming?.();
      const progress = timing?.duration
        ? Math.max(0, Math.min(1, timing.currentTime / timing.duration))
        : visualization.status === "ended"
          ? 1
          : 0;

      setExampleProgress(progress);

      if (visualization.status === "playing") {
        frame = window.requestAnimationFrame(tick);
      }
    };

    tick();
    onCleanup(() => {
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    });
  });

  const playExample = async (label: string, fallbackText: string, sources: readonly AudioSource[]) => {
    const source = chooseRandomAudioSource(sources);

    if (!source) {
      setExampleError("No recorded example is available for this target yet.");
      return;
    }

    setExampleError(null);
    setExampleLabel(label);
    setExampleProgress(0);

    void getPrecomputedSpectrogram(resolveAudioSourceForAnalysis(source.src))
      .then(setExampleSpectrogram)
      .catch((error) => {
        setExampleSpectrogram(null);
        setExampleError(error instanceof Error ? error.message : "Could not draw example formants.");
      });

    try {
      await playAudioSources(
        [source],
        fallbackText,
        {
          fallbackLang: props.language.defaultSpeechLang,
          preferredLangs: props.language.speechLangs,
          ttsEnabled: false,
        },
        label,
        getAudioFeedbackPath(source),
      );
    } catch (playError) {
      setExampleError(playError instanceof Error ? playError.message : "Could not play the example.");
    }
  };

  const playSelectedExample = async (word: WordEntry) => {
    await playExample(word.written, word.speechText ?? word.written, word.audio);
  };

  const playRandomSelectedVowelExample = async () => {
    const word = chooseRandomWordWithRecording(selectedTargetWords());

    if (!word) {
      setExampleError("No recorded example is available yet.");
      return;
    }

    await playSelectedExample(word);
  };

  return (
    <section class="training-panel target-practice-panel">
      <div class="panel-heading">
        <p class="eyebrow">Target practice</p>
        <h2>Live vowel space</h2>
      </div>
      <p class="instructions">
        Choose one or two vowel sounds from the sound library below, listen to examples, then use the microphone to guide your voice toward the target on the chart.
      </p>
      <p class="interaction-hint target-practice-status">{statusText()}</p>

      <Show when={tracker.error()}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>
      <Show when={exampleError()}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <Show when={targets().length > 0} fallback={<p class="muted">This language does not have vowel targets yet.</p>}>
        <div class="target-practice-layout">
          <div>
            <TargetPracticeFormantChart
              targets={selectedTargets()}
              targetPaths={selectedTargetPaths()}
              liveFormants={tracker.track()}
              exampleFormants={exampleSpectrogram()?.formants}
              exampleProgress={exampleProgress()}
              selectedLabel={selectedPracticeLabel()}
              exampleLabel={exampleLabel()}
            />
          </div>

          <aside class="target-practice-controls">
            <div class="target-practice-actions">
              <button
                class="primary-button"
                type="button"
                disabled={!tracker.micAvailable() || tracker.status() === "starting" || tracker.status() === "listening"}
                onClick={() => void tracker.start()}
              >
                Start microphone
              </button>
              <button
                class="primary-button secondary"
                type="button"
                disabled={tracker.status() !== "listening" && tracker.status() !== "starting"}
                onClick={tracker.stop}
              >
                Stop microphone
              </button>
              <Show when={selectedExampleWords().length > 0} fallback={
                <button
                  class="small-button"
                  type="button"
                  disabled={!selectedExampleAvailable()}
                  onClick={() => void playRandomSelectedVowelExample()}
                >
                  Play example
                </button>
              }>
                <For each={selectedExampleWords()}>
                  {(word) => (
                    <button
                      class="small-button"
                      type="button"
                      disabled={word.audio.length === 0 || !selectedExampleAvailable()}
                      onClick={() => void playSelectedExample(word)}
                    >
                      Play {word.written}
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <div class="target-practice-readout">
              <span>Microphone</span>
              <strong>{microphoneStatusText()}</strong>
            </div>
            <div class="target-practice-meter" aria-label="Microphone level">
              <span style={`width: ${Math.round(tracker.level() * 100)}%;`} />
            </div>
            <p class="muted">
              A quiet room helps the chart follow your voice more clearly.
            </p>
          </aside>
        </div>

        <Show when={selectedTargetPair()}>
          <section class="target-word-practice-list">
            <div class="column-title">
              <h3>Choose what to practise</h3>
              <span>Closest word pairs for these sounds</span>
            </div>
            <div class="target-word-grid">
              <Show when={contrastWordPairs().length > 0} fallback={<p class="muted">No word pairs are available for these sounds yet.</p>}>
                <For each={contrastWordPairs()}>
                  {(pair) => (
                    <div class={selectedPracticeId() === `pair:${pair.id}` ? "target-word-card selected" : "target-word-card"}>
                      <button
                        class="target-word-select"
                        type="button"
                        onClick={() => setSelectedPracticeId(`pair:${pair.id}`)}
                      >
                        <span>{pair.terms.map((term) => term.word.written).join(" / ")}</span>
                        <small class="ipa-text">{pair.terms.map((term) => term.word.ipa).join(" vs ")}</small>
                      </button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </section>
        </Show>
      </Show>
    </section>
  );
}

function TargetPracticeFormantChart(props: {
  targets: readonly FormantTarget[];
  targetPaths: readonly FormantTargetPath[];
  liveFormants: FormantTrack;
  exampleFormants?: FormantTrack;
  exampleProgress: number;
  selectedLabel: string;
  exampleLabel: string | null;
}) {
  let canvas: HTMLCanvasElement | undefined;
  const draw = () => paintFormantTargetChart(
    canvas,
    props.targets,
    props.exampleFormants,
    props.exampleFormants ? props.exampleProgress : 0,
    props.liveFormants,
    props.targetPaths,
  );

  createEffect(draw);

  onMount(() => {
    draw();

    if (!canvas || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(draw);

    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="contribution-formant-target target-practice-chart">
      <div class="formant-legend contribution-formant-legend" aria-hidden="true">
        <span>Target</span>
        <span>Your voice</span>
      </div>
      <div class="formant-frame contribution-formant-frame">
        <canvas
          ref={(element) => { canvas = element; }}
          aria-label="Live target vowel formant positions"
        />
      </div>
      <Show when={props.targets.length > 0 || props.targetPaths.length > 0} fallback={<p class="muted">Pick a vowel target.</p>}>
        <p class="contribution-formant-caption">
          Aim for {props.selectedLabel}. The red trail shows your voice.
          {props.exampleLabel ? <> The example recording is shown in blue.</> : null}
        </p>
      </Show>
    </div>
  );
}

function createLiveFormantTracker() {
  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let silentGain: GainNode | undefined;
  let stream: MediaStream | undefined;
  let rollingSamples: Float32Array<ArrayBuffer> = new Float32Array(0);
  let frameSampleCount = 0;
  let startedAt = 0;
  let lastAnalysisAt = 0;
  let smoothedF1: number | null = null;
  let smoothedF2: number | null = null;
  const [status, setStatus] = createSignal<LiveFormantTrackerStatus>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [track, setTrack] = createSignal<FormantTrack>(emptyLiveFormantTrack());
  const [latest, setLatest] = createSignal<FormantTrack["points"][number] | null>(null);
  const [level, setLevel] = createSignal(0);
  const micAvailable = () =>
    typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && Boolean(window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

  const resetAnalysis = () => {
    rollingSamples = new Float32Array(0);
    frameSampleCount = 0;
    startedAt = 0;
    lastAnalysisAt = 0;
    smoothedF1 = null;
    smoothedF2 = null;
    setTrack(emptyLiveFormantTrack());
    setLatest(null);
    setLevel(0);
  };

  const stopAudio = () => {
    processor?.disconnect();
    silentGain?.disconnect();
    source?.disconnect();
    processor = undefined;
    silentGain = undefined;
    source = undefined;

    if (audioContext?.state !== "closed") {
      void audioContext?.close();
    }

    audioContext = undefined;
    stopStream(stream);
    stream = undefined;
  };

  const appendAudio = (samples: Float32Array<ArrayBufferLike>, maxLength: number) => {
    rollingSamples = appendLiveSamples(rollingSamples, samples, maxLength);
  };

  const analyzeFrame = (sampleRate: number) => {
    const now = performance.now();

    if (rollingSamples.length < frameSampleCount || now - lastAnalysisAt < LIVE_FORMANT_ANALYSIS_HOP_MS) {
      return;
    }

    lastAnalysisAt = now;
    const frame = rollingSamples.slice(rollingSamples.length - frameSampleCount);
    const estimate = estimateLiveFormants(frame, sampleRate);
    const normalizedEnergy = Math.max(0, Math.min(1, estimate.energy / 0.045));
    const time = Math.max(0, (now - startedAt) / 1000);
    let f1: number | null = null;
    let f2: number | null = null;

    setLevel(normalizedEnergy);

    if (estimate.f1 !== null && estimate.f2 !== null) {
      smoothedF1 = smoothedF1 === null ? estimate.f1 : smoothedF1 * 0.68 + estimate.f1 * 0.32;
      smoothedF2 = smoothedF2 === null ? estimate.f2 : smoothedF2 * 0.68 + estimate.f2 * 0.32;
      f1 = Math.round(smoothedF1);
      f2 = Math.round(smoothedF2);
    } else if (normalizedEnergy < 0.12) {
      smoothedF1 = null;
      smoothedF2 = null;
    }

    const point = { time, f1, f2, energy: normalizedEnergy };

    setLatest(point);
    setTrack((current) => ({
      ...current,
      points: [...current.points, point].filter((candidate) => time - candidate.time <= LIVE_FORMANT_TRAIL_SECONDS),
      duration: Math.max(LIVE_FORMANT_TRAIL_SECONDS, time),
    }));
  };

  const handleAudioProcess = (event: AudioProcessingEvent) => {
    const context = audioContext;

    if (!context || frameSampleCount <= 0 || startedAt <= 0) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);

    output.fill(0);
    appendAudio(input, Math.max(frameSampleCount * 3, input.length));
    analyzeFrame(context.sampleRate);
  };

  const start = async () => {
    if (status() === "starting" || status() === "listening") {
      return;
    }

    if (!micAvailable()) {
      setStatus("error");
      setError("Microphone input is not available in this browser.");
      return;
    }

    stopAudio();
    resetAnalysis();
    setStatus("starting");
    setError(null);

    try {
      const AudioContextConstructor = window.AudioContext
        ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextConstructor) {
        throw new Error("Web Audio is not available in this browser.");
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      audioContext = new AudioContextConstructor();

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      frameSampleCount = Math.max(512, Math.round(audioContext.sampleRate * LIVE_FORMANT_FRAME_SECONDS));
      startedAt = performance.now();
      lastAnalysisAt = 0;
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(2048, 1, 1);
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.onaudioprocess = handleAudioProcess;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
      setStatus("listening");
    } catch (startError) {
      stopAudio();
      resetAnalysis();
      setStatus("error");
      setError(startError instanceof Error ? startError.message : "Could not start microphone target practice.");
    }
  };

  const stop = () => {
    stopAudio();
    setStatus("idle");
    setError(null);
    setLevel(0);
    setLatest(null);
  };

  onCleanup(stop);

  return {
    status,
    error,
    track,
    latest,
    level,
    micAvailable,
    start,
    stop,
  };
}

function emptyLiveFormantTrack(): FormantTrack {
  return {
    points: [],
    duration: LIVE_FORMANT_TRAIL_SECONDS,
    minHz: 0,
    maxHz: LIVE_FORMANT_DISPLAY_MAX_HZ,
  };
}

function appendLiveSamples(
  current: Float32Array<ArrayBuffer>,
  incoming: Float32Array<ArrayBufferLike>,
  maxLength: number,
): Float32Array<ArrayBuffer> {
  const incomingLength = Math.min(incoming.length, maxLength);
  const incomingSamples = new Float32Array(incomingLength);

  incomingSamples.set(incoming.subarray(incoming.length - incomingLength));
  const retainedLength = Math.min(current.length, Math.max(0, maxLength - incomingSamples.length));
  const next = new Float32Array(retainedLength + incomingSamples.length);

  if (retainedLength > 0) {
    next.set(current.subarray(current.length - retainedLength), 0);
  }

  next.set(incomingSamples, retainedLength);
  return next;
}

function targetPracticeVowelsForLanguage(sourceDataset: LanguageDataset): TargetPracticeVowel[] {
  return sourceDataset.phonemes.flatMap((phoneme) => {
    const target = formantTargetForPhoneme(phoneme);

    if (!target) {
      return [];
    }

    return [{
      name: phoneme.label,
      audio: phoneme.audio ?? [],
      ...target,
    }];
  });
}

function targetPracticeInitialPhonemeIds(
  sourceDataset: LanguageDataset,
  preferredPhonemeIds: readonly PhonemeId[] | null,
): PhonemeId[] {
  const preferredTargets = (preferredPhonemeIds ?? [])
    .filter((phonemeId) => {
      const phoneme = sourceDataset.phonemes.find((candidate) => candidate.id === phonemeId);

      return Boolean(phoneme && formantTargetForPhoneme(phoneme));
    })
    .slice(0, 2);

  if (preferredTargets.length > 0) {
    return preferredTargets;
  }

  const firstTarget = sourceDataset.phonemes.find((phoneme) => Boolean(formantTargetForPhoneme(phoneme)));

  return firstTarget ? [firstTarget.id] : [];
}

function formantContrastTargetStyle(index: number): FormantPathStyle {
  return FORMANT_CONTRAST_CHART_STYLES[Math.max(0, index) % FORMANT_CONTRAST_CHART_STYLES.length]?.target
    ?? TARGET_FORMANT_PATH_STYLE;
}

function formantContrastWordStyle(index: number): FormantPathStyle {
  return FORMANT_CONTRAST_CHART_STYLES[Math.max(0, index) % FORMANT_CONTRAST_CHART_STYLES.length]?.word
    ?? WORD_FORMANT_PATH_STYLE;
}

function formantTargetPathForWord(
  word: WordEntry,
  sourceDataset: LanguageDataset,
  style?: FormantPathStyle,
): FormantTargetPath | undefined {
  const points = word.phonemeIds.flatMap((phonemeId): FormantTargetPathPoint[] => {
    const phoneme = sourceDataset.phonemes.find((candidate) => candidate.id === phonemeId);
    const target = phoneme ? formantTargetForPhoneme(phoneme) : undefined;

    if (!target) {
      return [];
    }

    return formantPathPointsForTarget(target);
  });

  if (points.length === 0) {
    return undefined;
  }

  return {
    id: `word:${word.id}`,
    label: word.written,
    points,
    style,
  };
}

function ContributionModeCallout(props: {
  queue: readonly ContributionQueueItem[];
  onStart: () => void;
}) {
  return (
    <section class="contribution-mode-callout">
      <div>
        <p class="eyebrow">Contribute recordings</p>
        <Show
          when={props.queue.length > 0}
          fallback={<p>No contribution words are waiting right now.</p>}
        >
          <p>Record a few words and download one ZIP when you are done.</p>
        </Show>
      </div>
      <button class="primary-button" type="button" disabled={props.queue.length === 0} onClick={props.onStart}>
        Contribute recordings
      </button>
    </section>
  );
}

function CatalogPanel(props: {
  mode: TrainingMode;
  tab: CatalogTab;
  activePhonemePair: PhonemePair | null;
  draftPhonemeIds: readonly PhonemeId[];
  explorePhonemeId: PhonemeId | null;
  audioError: string | null;
  availableDataset: LanguageDataset;
  ttsEnabled: boolean;
  showUnrecordedPhonemes: boolean;
  onTabChange: (tab: CatalogTab) => void;
  onPhonemeSelect: (phonemeId: PhonemeId) => void;
  onPhonemeExplore: (phonemeId: PhonemeId) => void;
  onExploreClose: () => void;
  onShowUnrecordedPhonemesChange: (showUnrecordedPhonemes: boolean) => void;
  onPairSelect: (phonemePair: PhonemePair, mode?: TrainingMode) => void;
  onPairClear: () => void;
  onRandomRecordingPlay: (word: WordEntry) => void;
  onWordTtsPlay: (word: WordEntry) => void;
  onTrackPlay: (word: WordEntry, source: AudioSource) => void;
  onContribute: (word: WordEntry) => void;
}) {
  const exploredPhoneme = createMemo(() =>
    props.explorePhonemeId
      ? dataset.phonemes.find((phoneme) => phoneme.id === props.explorePhonemeId)
      : undefined,
  );

  return (
    <section class="catalog-panel">
      <nav class="catalog-tabs" aria-label="Inventory view">
        <button
          class={props.tab === "phonemes" ? "catalog-tab selected" : "catalog-tab"}
          type="button"
          onClick={() => props.onTabChange("phonemes")}
        >
          Sounds
        </button>
        <button
          class={props.tab === "contrasts" ? "catalog-tab selected" : "catalog-tab"}
          type="button"
          onClick={() => props.onTabChange("contrasts")}
        >
          Ready-made contrasts
        </button>
      </nav>

      <Show
        when={props.tab === "phonemes"}
        fallback={
          <PremadeContrastsPanel
            availableDataset={props.availableDataset}
            activePhonemePair={props.activePhonemePair}
            onPairSelect={props.onPairSelect}
          />
        }
      >
        <Show
          when={exploredPhoneme()}
          fallback={
            <PhonemePicker
              mode={props.mode}
              availableDataset={props.availableDataset}
              showUnrecordedPhonemes={props.showUnrecordedPhonemes}
              activePhonemePair={props.activePhonemePair}
              draftPhonemeIds={props.draftPhonemeIds}
              onPhonemeSelect={props.onPhonemeSelect}
              onPhonemeExplore={props.onPhonemeExplore}
              onShowUnrecordedPhonemesChange={props.onShowUnrecordedPhonemesChange}
              onPairSelect={props.onPairSelect}
              onPairClear={props.onPairClear}
              onRandomRecordingPlay={props.onRandomRecordingPlay}
            />
          }
        >
          {(phoneme) => (
            <PhonemeExplorer
              phoneme={phoneme()}
              availableDataset={props.availableDataset}
              ttsEnabled={props.ttsEnabled}
              audioError={props.audioError}
              onBack={props.onExploreClose}
              onRandomRecordingPlay={props.onRandomRecordingPlay}
              onWordTtsPlay={props.onWordTtsPlay}
              onTrackPlay={props.onTrackPlay}
              onContribute={props.onContribute}
            />
          )}
        </Show>
      </Show>
    </section>
  );
}

function PhonemePicker(props: {
  mode: TrainingMode;
  availableDataset: LanguageDataset;
  showUnrecordedPhonemes: boolean;
  activePhonemePair: PhonemePair | null;
  draftPhonemeIds: readonly PhonemeId[];
  onPhonemeSelect: (phonemeId: PhonemeId) => void;
  onPhonemeExplore: (phonemeId: PhonemeId) => void;
  onShowUnrecordedPhonemesChange: (showUnrecordedPhonemes: boolean) => void;
  onPairSelect: (phonemePair: PhonemePair, mode?: TrainingMode) => void;
  onPairClear: () => void;
  onRandomRecordingPlay: (word: WordEntry) => void;
}) {
  const selectablePhonemes = createMemo(() => dataset.phonemes.filter((phoneme) =>
    props.mode !== "target" || Boolean(formantTargetForPhoneme(phoneme))
  ));
  const recordedPhonemes = createMemo(() => selectablePhonemes().filter((phoneme) => phonemeHasWordRecording(phoneme.id, props.availableDataset)));
  const unrecordedPhonemes = createMemo(() => selectablePhonemes().filter((phoneme) => !phonemeHasWordRecording(phoneme.id, props.availableDataset)));
  const visiblePhonemes = createMemo(() => props.showUnrecordedPhonemes
    ? [...recordedPhonemes(), ...unrecordedPhonemes()]
    : recordedPhonemes()
  );

  return (
    <>
      <div class="phoneme-selection-bar">
        <Show when={props.mode === "target"} fallback={
          <>
            <Show
              when={props.activePhonemePair}
              fallback={<p>Pick any two sounds to make your own practice round.</p>}
            >
              {(phonemePair) => (
                <p>
                  Current practice: <strong class="ipa-text">{phonemePairLabel(phonemePair())}</strong>
                </p>
              )}
            </Show>
            <Show when={props.draftPhonemeIds.length === 1}>
              <p class="muted">Selected <span class="ipa-text">{phonemeLabel(props.draftPhonemeIds[0] ?? "")}</span>. Pick one more.</p>
            </Show>
          </>
        }>
          <p>Choose one vowel to practise it, or choose two to practise a contrast.</p>
          <Show when={props.draftPhonemeIds.length > 0}>
            <p class="muted">Targeting <span class="ipa-text">{phonemeIdsLabel(props.draftPhonemeIds)}</span>.</p>
          </Show>
        </Show>
        <div class="selection-actions">
          <Show when={props.activePhonemePair}>
            {(phonemePair) => (
              <>
                <button class="small-button" type="button" onClick={() => props.onPairSelect(phonemePair(), "match")}>
                  Match sounds
                </button>
                <button class="small-button" type="button" onClick={() => props.onPairSelect(phonemePair(), "sort")}>
                  Sort words
                </button>
                <button class="text-button compact" type="button" onClick={props.onPairClear}>
                  Back to mixed practice
                </button>
              </>
            )}
          </Show>
        </div>
      </div>

      <div class="phoneme-grid">
        <For each={visiblePhonemes()}>
          {(phoneme) => {
            const exampleWords = samplePhonemeCardWords(phoneme.id, dataset);

            return (
              <article
                class={phonemeCardClass(phoneme, props.draftPhonemeIds, props.activePhonemePair, !phonemeHasWordRecording(phoneme.id, props.availableDataset))}
                role="button"
                tabindex="0"
                onClick={() => props.onPhonemeSelect(phoneme.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    props.onPhonemeSelect(phoneme.id);
                  }
                }}
              >
                <div class="phoneme-main">
                  <span class="phoneme-ipa">{phoneme.ipa}</span>
                  <strong>{phoneme.label}</strong>
                  <small>{phoneme.category}</small>
                  <Show when={!phonemeHasWordRecording(phoneme.id, props.availableDataset)}>
                    <small class="phoneme-recording-status">No recordings yet</small>
                  </Show>
                </div>
                <Show when={phoneme.notes}>
                  {(notes) => <p>{notes()}</p>}
                </Show>
                <Show when={exampleWords.length > 0}>
                  <div class="phoneme-examples" aria-label={`Example words with ${phoneme.ipa}`}>
                    <span class="phoneme-examples-label">Examples</span>
                    <For each={exampleWords}>
                      {(word) => (
                        <Show
                          when={hasWordRecording(word)}
                          fallback={<span class="phoneme-example-word missing-recording" title={`${word.ipa} - no recordings yet`}>{word.written}</span>}
                        >
                          <button
                            class="phoneme-example-word"
                            type="button"
                            title={`Play ${word.written} ${word.ipa}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              props.onRandomRecordingPlay(word);
                            }}
                          >
                            {word.written}
                          </button>
                        </Show>
                      )}
                    </For>
                  </div>
                </Show>
                <button
                  class="text-button compact"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onPhonemeExplore(phoneme.id);
                  }}
                >
                  Explore words
                </button>
              </article>
            );
          }}
        </For>
      </div>
      <Show when={unrecordedPhonemes().length > 0}>
        <label class="explorer-option">
          <input
            type="checkbox"
            checked={props.showUnrecordedPhonemes}
            onInput={(event) => props.onShowUnrecordedPhonemesChange(event.currentTarget.checked)}
          />
          Show sounds without recordings
          <Show when={!props.showUnrecordedPhonemes}>
            <span>({unrecordedPhonemes().length} hidden)</span>
          </Show>
        </label>
      </Show>
    </>
  );
}

function PremadeContrastsPanel(props: {
  availableDataset: LanguageDataset;
  activePhonemePair: PhonemePair | null;
  onPairSelect: (phonemePair: PhonemePair, mode?: TrainingMode) => void;
}) {
  return (
    <div class="contrast-grid interactive">
      <For each={props.availableDataset.contrasts}>
        {(contrast) => (
          <button
            class={contrastCardClass(contrast, props.activePhonemePair)}
            type="button"
            onClick={() => props.onPairSelect(contrast.phonemeIds)}
          >
            <strong class="ipa-heading">{contrast.label}</strong>
            <p>{contrast.description}</p>
            <small>{contrast.minimalPairs.length} word pairs</small>
          </button>
        )}
      </For>
    </div>
  );
}

function PhonemeExplorer(props: {
  phoneme: Phoneme;
  availableDataset: LanguageDataset;
  ttsEnabled: boolean;
  audioError: string | null;
  onBack: () => void;
  onRandomRecordingPlay: (word: WordEntry) => void;
  onWordTtsPlay: (word: WordEntry) => void;
  onTrackPlay: (word: WordEntry, source: AudioSource) => void;
  onContribute: (word: WordEntry) => void;
}) {
  const [showMissingWords, setShowMissingWords] = createSignal(false);
  const recordedWords = createMemo(() => wordsForPhoneme(props.phoneme.id, props.availableDataset).filter(hasWordRecording));
  const missingWords = createMemo(() => wordsForPhoneme(props.phoneme.id, dataset).filter((word) => word.audio.length === 0));
  const visibleMissingWords = createMemo(() => showMissingWords() ? missingWords() : []);
  const visibleWordCount = createMemo(() => recordedWords().length + visibleMissingWords().length);

  createEffect(() => {
    setShowMissingWords(recordedWords().length === 0 && missingWords().length > 0);
  });

  return (
    <section class="phoneme-explorer">
      <button class="text-button compact" type="button" onClick={props.onBack}>
        Back to sounds
      </button>
      <div class="phoneme-explorer-heading">
        <span class="phoneme-ipa large">{props.phoneme.ipa}</span>
        <div>
          <h3>{props.phoneme.label}</h3>
          <p>{props.phoneme.notes ?? `${visibleWordCount()} words here use this sound.`}</p>
        </div>
      </div>

      <Show when={props.audioError}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <div class="explore-word-list">
        <Show when={visibleWordCount() > 0} fallback={<p class="muted">{props.ttsEnabled ? "No words for this sound yet." : "No recorded words for this sound yet."}</p>}>
          <For each={recordedWords()}>
            {(word) => <ExploreWordCard word={word} {...props} />}
          </For>
          <Show when={visibleMissingWords().length > 0}>
            <section class="missing-recordings-section">
              <h4>Missing recordings</h4>
              <p class="muted">These words use this sound but do not have recordings yet.</p>
              <For each={visibleMissingWords()}>
                {(word) => <ExploreWordCard word={word} {...props} />}
              </For>
            </section>
          </Show>
        </Show>
        <Show when={missingWords().length > 0}>
          <label class="explorer-option">
            <input
              type="checkbox"
              checked={showMissingWords()}
              onInput={(event) => setShowMissingWords(event.currentTarget.checked)}
            />
            Show words missing recordings
            <Show when={!showMissingWords()}>
              <span>({missingWords().length} hidden)</span>
            </Show>
          </label>
        </Show>
      </div>
    </section>
  );
}

function ExploreWordCard(props: {
  word: WordEntry;
  ttsEnabled: boolean;
  onRandomRecordingPlay: (word: WordEntry) => void;
  onWordTtsPlay: (word: WordEntry) => void;
  onTrackPlay: (word: WordEntry, source: AudioSource) => void;
  onContribute: (word: WordEntry) => void;
}) {
  return (
    <article class="explore-word-card">
      <div class="explore-word-heading">
        <div>
          <strong>{props.word.written}</strong>
          <span class="ipa-text">{props.word.ipa}</span>
        </div>
        <div class="explore-actions">
          <button
            class="small-button"
            type="button"
            disabled={props.word.audio.length === 0}
            onClick={() => props.onRandomRecordingPlay(props.word)}
          >
            Play random recording
          </button>
          <Show when={props.ttsEnabled}>
            <button class="small-button" type="button" onClick={() => props.onWordTtsPlay(props.word)}>
              Browser voice
            </button>
          </Show>
          <button class="small-button" type="button" onClick={() => props.onContribute(props.word)}>
            Contribute a recording
          </button>
        </div>
      </div>

      <Show
        when={props.word.audio.length > 0}
        fallback={props.ttsEnabled
          ? <p class="muted">No recording yet; browser voice is available.</p>
          : <p class="muted">No recording yet.</p>}
      >
        <div class="track-list">
          <For each={props.word.audio}>
            {(source, index) => (
              <div class="track-row">
                <button class="text-button compact" type="button" onClick={() => props.onTrackPlay(props.word, source)}>
                  Play track {index() + 1}
                </button>
                <AudioFeedbackButton path={getAudioFeedbackPath(source)} />
                <span>
                  {[source.accent, source.license].filter(Boolean).join(" · ") || source.kind}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </article>
  );
}

function createContributionRecorder(getWordWritten: () => string) {
  let recorder: MediaRecorder | undefined;
  let activeStream: MediaStream | undefined;
  let countdownInterval: number | undefined;
  let stopTimeout: number | undefined;
  let timelineFrame: number | undefined;
  let chunks: BlobPart[] = [];
  const [status, setStatus] = createSignal<ContributionRecorderStatus>("idle");
  const [countdownSeconds, setCountdownSeconds] = createSignal(CONTRIBUTION_COUNTDOWN_SECONDS);
  const [timelineElapsedMs, setTimelineElapsedMs] = createSignal(0);
  const [recordingBlob, setRecordingBlob] = createSignal<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const recorderAvailable = () =>
    typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
  const recordingInProgress = createMemo(() => status() === "preparing" || status() === "countdown" || status() === "recording");
  const countdownProgressPercent = createMemo(() =>
    Math.min(100, Math.max(0, (timelineElapsedMs() / CONTRIBUTION_COUNTDOWN_DURATION_MS) * 100))
  );
  const recordingProgressPercent = createMemo(() =>
    Math.min(100, Math.max(0, ((timelineElapsedMs() - CONTRIBUTION_COUNTDOWN_DURATION_MS) / CONTRIBUTION_RECORDING_DURATION_MS) * 100))
  );
  const timelineMessage = createMemo(() => {
    if (status() === "preparing") {
      return "Preparing the microphone, then the countdown will begin.";
    }

    if (status() === "countdown") {
      return `Get ready. Recording starts in ${countdownSeconds()}...`;
    }

    if (status() === "recording") {
      return `Recording now. Say “${getWordWritten()}”.`;
    }

    if (status() === "recorded") {
      return "Recorded. Listen back before continuing.";
    }

    return "Press start, wait through the three second countdown, then speak during the final two second segment.";
  });
  const recordButtonText = createMemo(() => {
    if (status() === "preparing") {
      return "Preparing...";
    }

    if (status() === "countdown") {
      return `Get ready: ${countdownSeconds()}`;
    }

    if (status() === "recording") {
      return "Recording...";
    }

    return "Start recording";
  });

  createEffect(() => {
    const url = recordingUrl();

    onCleanup(() => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    });
  });

  onCleanup(() => {
    clearRecordingTimers();
    if (recorder?.state === "recording") {
      recorder.stop();
    }
    stopStream(activeStream);
  });

  const startRecording = async () => {
    if (recordingInProgress()) {
      return;
    }

    if (!recorderAvailable()) {
      setError("Recording is not available in this browser.");
      return;
    }

    clearRecordingTimers();
    setError(null);
    setRecordingBlob(null);
    setRecordingUrl(null);
    setTimelineElapsedMs(0);
    setStatus("preparing");
    chunks = [];

    try {
      activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseRecordingMimeType();
      recorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);

      debugContributionAudio("recorder created", {
        requestedMimeType: mimeType || null,
        recorderMimeType: recorder.mimeType || null,
      });

      recorder.addEventListener("dataavailable", (event) => {
        debugContributionAudio("recorder dataavailable", {
          size: event.data.size,
          type: event.data.type || null,
        });

        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" });

        clearRecordingTimers();
        setTimelineElapsedMs(CONTRIBUTION_TIMELINE_DURATION_MS);
        stopStream(activeStream);
        activeStream = undefined;
        recorder = undefined;
        setRecordingBlob(blob);
        setRecordingUrl(URL.createObjectURL(blob));
        setStatus("recorded");
        debugContributionAudio("recorder stopped", {
          blobSize: blob.size,
          blobType: blob.type || null,
          chunkCount: chunks.length,
        });
      }, { once: true });
      beginRecordingCountdown();
    } catch (recordingError) {
      clearRecordingTimers();
      stopStream(activeStream);
      activeStream = undefined;
      recorder = undefined;
      setTimelineElapsedMs(0);
      setStatus("idle");
      setError(recordingError instanceof Error ? recordingError.message : "Could not start recording.");
    }
  };

  const beginRecordingCountdown = () => {
    let remaining = CONTRIBUTION_COUNTDOWN_SECONDS;

    setCountdownSeconds(remaining);
    setStatus("countdown");
    startTimelineProgress();
    countdownInterval = window.setInterval(() => {
      remaining -= 1;

      if (remaining <= 0) {
        clearCountdownTimer();
        beginTimedRecording();
        return;
      }

      setCountdownSeconds(remaining);
    }, 1000);
  };

  const beginTimedRecording = () => {
    if (!recorder || recorder.state !== "inactive") {
      clearRecordingTimers();
      stopStream(activeStream);
      activeStream = undefined;
      recorder = undefined;
      setTimelineElapsedMs(0);
      setStatus("idle");
      setError("Could not start recording.");
      return;
    }

    try {
      recorder.start();
      setStatus("recording");
      stopTimeout = window.setTimeout(() => {
        if (recorder?.state === "recording") {
          recorder.stop();
        }
      }, CONTRIBUTION_RECORDING_DURATION_MS);
    } catch (recordingError) {
      clearRecordingTimers();
      stopStream(activeStream);
      activeStream = undefined;
      recorder = undefined;
      setTimelineElapsedMs(0);
      setStatus("idle");
      setError(recordingError instanceof Error ? recordingError.message : "Could not start recording.");
    }
  };

  const clearRecordingTimers = () => {
    clearCountdownTimer();
    clearTimelineProgress();

    if (stopTimeout !== undefined) {
      window.clearTimeout(stopTimeout);
      stopTimeout = undefined;
    }
  };

  const clearCountdownTimer = () => {
    if (countdownInterval !== undefined) {
      window.clearInterval(countdownInterval);
      countdownInterval = undefined;
    }
  };

  const startTimelineProgress = () => {
    const startedAt = performance.now();

    clearTimelineProgress();
    setTimelineElapsedMs(0);
    const tick = (now: number) => {
      const elapsed = Math.min(CONTRIBUTION_TIMELINE_DURATION_MS, now - startedAt);

      setTimelineElapsedMs(elapsed);
      if (elapsed < CONTRIBUTION_TIMELINE_DURATION_MS && (status() === "countdown" || status() === "recording")) {
        timelineFrame = window.requestAnimationFrame(tick);
        return;
      }

      timelineFrame = undefined;
    };

    timelineFrame = window.requestAnimationFrame(tick);
  };

  const clearTimelineProgress = () => {
    if (timelineFrame !== undefined) {
      window.cancelAnimationFrame(timelineFrame);
      timelineFrame = undefined;
    }
  };

  const stopRecording = () => {
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  };

  const discardRecording = () => {
    clearRecordingTimers();
    stopRecording();
    setRecordingBlob(null);
    setRecordingUrl(null);
    setTimelineElapsedMs(0);
    setStatus("idle");
    setError(null);
  };

  const discardAndRecordAgain = async () => {
    discardRecording();
    await startRecording();
  };

  const restoreRecording = (blob: Blob) => {
    clearRecordingTimers();
    stopStream(activeStream);
    activeStream = undefined;
    recorder = undefined;
    chunks = [];
    setError(null);
    setRecordingBlob(blob);
    setRecordingUrl(URL.createObjectURL(blob));
    setTimelineElapsedMs(CONTRIBUTION_TIMELINE_DURATION_MS);
    setStatus("recorded");
  };

  return {
    status,
    timelineElapsedMs,
    recordingBlob,
    recordingUrl,
    error,
    recorderAvailable,
    recordingInProgress,
    countdownProgressPercent,
    recordingProgressPercent,
    timelineMessage,
    recordButtonText,
    startRecording,
    discardRecording,
    discardAndRecordAgain,
    restoreRecording,
  };
}

function RecordingTimeline(props: {
  status: ContributionRecorderStatus;
  timelineElapsedMs: number;
  countdownProgressPercent: number;
  recordingProgressPercent: number;
  message: string;
}) {
  return (
    <div
      class="recording-timeline"
      data-state={props.status}
      role="progressbar"
      aria-label="Recording countdown and capture progress"
      aria-valuemin={0}
      aria-valuemax={CONTRIBUTION_TIMELINE_DURATION_MS / 1000}
      aria-valuenow={Math.round(props.timelineElapsedMs / 100) / 10}
      style={`--countdown-progress: ${props.countdownProgressPercent}%; --recording-progress: ${props.recordingProgressPercent}%;`}
    >
      <div class="recording-timeline-bar" aria-hidden="true">
        <div class="recording-timeline-segment countdown-segment">
          <div class="recording-timeline-segment-fill countdown-fill" />
          <span>Get ready</span>
          <strong>{CONTRIBUTION_COUNTDOWN_SECONDS}s</strong>
        </div>
        <div class="recording-timeline-segment recording-segment">
          <div class="recording-timeline-segment-fill recording-fill" />
          <span>Speak</span>
          <strong>{CONTRIBUTION_RECORDING_DURATION_MS / 1000}s</strong>
        </div>
      </div>
      <div class="recording-timeline-labels" aria-hidden="true">
        <span>Countdown</span>
        <span>Recording</span>
      </div>
      <p class="recording-timeline-help">{props.message}</p>
    </div>
  );
}

function ContributionModePage(props: {
  language: LanguageDataset;
  queue: readonly ContributionQueueItem[];
  onBack: () => void;
  onContributionDownloaded: (wordIds: readonly string[]) => void;
  onContributionSpeakerNameChange: (speakerName: string) => void;
}) {
  const savedContributionDetails = loadContributionDetails();
  const recorder = createContributionRecorder(() => activeItem()?.word.written ?? "the word");
  const [keptRecordings, setKeptRecordings] = createSignal<KeptContributionRecording[]>([]);
  const [skippedWordIds, setSkippedWordIds] = createSignal<string[]>([]);
  const [licence, setLicence] = createSignal<ContributionLicence>(savedContributionDetails.licence);
  const [speakerName, setSpeakerName] = createSignal(savedContributionDetails.speakerName);
  const [accent, setAccent] = createSignal(savedContributionDetails.accent);
  const [downloadStatus, setDownloadStatus] = createSignal<ContributionDownloadStatus>("idle");
  const [downloadError, setDownloadError] = createSignal<string | null>(null);
  const [recordingPreviewProgress, setRecordingPreviewProgress] = createSignal(0);
  const [recordingPreviewRequested, setRecordingPreviewRequested] = createSignal(false);
  const [recordingPreviewPlayed, setRecordingPreviewPlayed] = createSignal(false);
  const initialCandidateWordIds = new Set(props.queue.map((item) => item.word.id));
  const [sessionItems, setSessionItems] = createSignal<ContributionQueueItem[]>(createContributionQueue(
    props.language,
    new Set(),
    {
      candidateWordIds: initialCandidateWordIds,
      limit: CONTRIBUTION_SESSION_QUEUE_SIZE,
    },
  ));
  let recordingPreviewAudio: HTMLAudioElement | undefined;

  const keptWordIds = createMemo(() => new Set(keptRecordings().map((recording) => recording.word.id)));
  const skippedWordIdSet = createMemo(() => new Set(skippedWordIds()));
  const candidateWordIds = createMemo(() => new Set(props.queue.map((item) => item.word.id)));
  const remainingItems = createMemo(() => sessionItems());
  const activeItem = createMemo(() => remainingItems()[0]);
  const upcomingItems = createMemo(() => remainingItems().slice(1, 6));
  const requiresAttributionName = createMemo(() => licence() === "CC-BY-4.0");
  const hasCurrentRecording = createMemo(() => Boolean(activeItem() && recorder.recordingBlob()));
  const canDownload = createMemo(() =>
    (keptRecordings().length > 0 || hasCurrentRecording())
    && (!requiresAttributionName() || speakerName().trim().length > 0)
  );
  const canUndoLastKeptRecording = createMemo(() =>
    keptRecordings().length > 0
    && !recorder.recordingInProgress()
    && !recorder.recordingBlob()
  );
  const pageError = createMemo(() => recorder.error() ?? downloadError());
  const downloadButtonText = createMemo(() => {
    if (downloadStatus() === "downloading") {
      return "Downloading...";
    }

    if (downloadStatus() === "downloaded") {
      return "Downloaded";
    }

    return "Finish and download ZIP";
  });

  createEffect(() => {
    saveContributionDetails({
      schemaVersion: 1,
      licence: licence(),
      speakerName: speakerName().trim(),
      accent: accent().trim(),
    });
  });

  createEffect(() => {
    const allowedWordIds = candidateWordIds();
    const keptIds = keptWordIds();
    const skippedIds = skippedWordIdSet();

    setSessionItems((current) => fillContributionSessionQueue(current, allowedWordIds, keptIds, skippedIds, props.language));
  });

  const recordingPreviewTracker = createAudioPlaybackProgressTracker(
    "batch-preview",
    setRecordingPreviewProgress,
  );

  createEffect(() => {
    activeItem();
    const recordingUrl = recorder.recordingUrl();

    recordingPreviewTracker.stop();
    if (!recordingUrl) {
      recordingPreviewAudio = undefined;
    } else if (recordingPreviewAudio) {
      loadRecordingPreviewAudio(recordingPreviewAudio);
    }
    setRecordingPreviewProgress(0);
    setRecordingPreviewRequested(false);
    setRecordingPreviewPlayed(false);
  });

  onCleanup(recordingPreviewTracker.stop);

  const canDownloadRecordings = (recordings: readonly KeptContributionRecording[]) =>
    recordings.length > 0 && (!requiresAttributionName() || speakerName().trim().length > 0);

  const startRecording = async () => {
    setDownloadError(null);
    await recorder.startRecording();
  };

  const retryRecording = async () => {
    setDownloadError(null);
    await recorder.discardAndRecordAgain();
  };

  const createCurrentRecording = (): KeptContributionRecording | null => {
    const item = activeItem();
    const blob = recorder.recordingBlob();

    if (!item || !blob) {
      return null;
    }

    const recording: KeptContributionRecording = {
      id: createContributionId(props.language.id, item.shortWordId),
      word: item.word,
      blob,
      mimeType: blob.type || "audio/webm",
      recordedAt: new Date().toISOString(),
    };

    return recording;
  };

  const keepCurrentRecording = (): KeptContributionRecording | null => {
    const recording = createCurrentRecording();

    if (!recording) {
      return null;
    }

    setKeptRecordings((current) => [...current, recording]);
    setDownloadStatus("idle");
    setDownloadError(null);
    return recording;
  };

  const keepAndNext = () => {
    if (recordingPreviewPlayed() && keepCurrentRecording()) {
      recorder.discardRecording();
    }
  };

  const recordingsForDownload = (): KeptContributionRecording[] => {
    const currentRecording = createCurrentRecording();

    return currentRecording ? [...keptRecordings(), currentRecording] : keptRecordings();
  };

  const undoLastKeptRecording = () => {
    if (!canUndoLastKeptRecording()) {
      return;
    }

    const recording = keptRecordings().at(-1);

    if (!recording) {
      return;
    }

    setKeptRecordings((current) => current.slice(0, -1));
    setSessionItems((current) => {
      const restoredItem = props.queue.find((item) => item.word.id === recording.word.id);

      return restoredItem
        ? [restoredItem, ...current.filter((item) => item.word.id !== recording.word.id)]
        : current;
    });
    recorder.restoreRecording(recording.blob);
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const setRecordingPreviewAudioElement = (audio: HTMLAudioElement) => {
    recordingPreviewAudio = audio;
    loadRecordingPreviewAudio(audio);
  };

  const playRecordingPreview = async () => {
    const recordingUrl = recorder.recordingUrl();

    if (!recordingUrl || !recordingPreviewAudio) {
      setDownloadError("Could not prepare recording preview.");
      return;
    }

    setRecordingPreviewRequested(true);
    setDownloadError(null);

    try {
      if (recordingPreviewAudio.getAttribute("src") !== recordingUrl) {
        recordingPreviewAudio.src = recordingUrl;
        recordingPreviewAudio.load();
      }

      recordingPreviewAudio.pause();
      if (recordingPreviewAudio.readyState > 0) {
        recordingPreviewAudio.currentTime = 0;
      }
      await recordingPreviewAudio.play();
      setRecordingPreviewPlayed(true);
    } catch (playError) {
      setDownloadError(playError instanceof Error ? playError.message : "Could not play recording preview.");
    }
  };

  const skipCurrent = () => {
    const item = activeItem();

    if (!item || recorder.recordingInProgress()) {
      return;
    }

    setSkippedWordIds((current) => current.includes(item.word.id) ? current : [...current, item.word.id]);
    recorder.discardRecording();
    setDownloadError(null);
  };

  const updateLicence = (nextLicence: ContributionLicence) => {
    setLicence(nextLicence);
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const updateSpeakerName = (nextSpeakerName: string) => {
    setSpeakerName(nextSpeakerName);
    props.onContributionSpeakerNameChange(nextSpeakerName.trim());
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const updateAccent = (nextAccent: string) => {
    setAccent(nextAccent);
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const downloadBatch = async (recordings = recordingsForDownload()) => {
    if (!canDownloadRecordings(recordings) || downloadStatus() === "downloading") {
      if (requiresAttributionName() && speakerName().trim().length === 0) {
        setDownloadError("CC BY 4.0 needs a name for attribution.");
      }
      return;
    }

    setDownloadStatus("downloading");
    setDownloadError(null);

    try {
      const bundleId = createContributionBatchId(props.language.id);
      const archiveEntries: Record<string, Uint8Array> = {};
      const manifestRecordings: ContributionBatchRecordingForManifest[] = [];

      for (const recording of recordings) {
        const filename = `recordings/${recording.id}.${extensionForMimeType(recording.mimeType)}`;

        archiveEntries[filename] = new Uint8Array(await recording.blob.arrayBuffer());
        manifestRecordings.push({
          id: recording.id,
          word: recording.word,
          filename,
          mimeType: recording.mimeType,
          recordingSize: recording.blob.size,
          recordedAt: recording.recordedAt,
        });
      }

      const manifest = createContributionBatchManifest({
        language: props.language,
        id: bundleId,
        recordings: manifestRecordings,
        licence: licence(),
        speakerName: speakerName().trim(),
        accent: accent().trim(),
      });
      const archive = zipSync({
        "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
        ...archiveEntries,
      }, { level: 0 });

      downloadBlob(
        new Blob([archive], { type: "application/zip" }),
        `${manifest.id}.zip`,
      );
      props.onContributionDownloaded(recordings.map((recording) => recording.word.id));
      setDownloadStatus("downloaded");
    } catch (downloadError) {
      setDownloadStatus("idle");
      setDownloadError(downloadError instanceof Error ? downloadError.message : "Could not download contribution batch.");
    }
  };

  return (
    <section class="content-panel contribution-panel contribution-mode-panel">
      <div class="contribution-nav">
        <button class="text-button compact" type="button" onClick={props.onBack}>
          Back to sound library
        </button>
      </div>

      <div class="panel-heading contribution-heading">
        <p class="eyebrow">Contribution mode</p>
        <h2>Record a batch</h2>
        <p>
          Record one word at a time. Listen back before keeping each recording.
        </p>
      </div>

      <section class="contribution-queue-summary">
        <div>
          <strong>{props.queue.length}</strong>
          <span>words available</span>
        </div>
        <div>
          <strong>{keptRecordings().length}</strong>
          <span>kept</span>
        </div>
        <div>
          <strong>{skippedWordIds().length}</strong>
          <span>skipped</span>
        </div>
      </section>

      <div class="contribution-session-grid">
        <div class="contribution-session-main">
          <Show
            when={activeItem()}
            fallback={
              <section class="contribution-card current-contribution-step">
                <p class="eyebrow">Queue complete</p>
                <h3>All set</h3>
                <p class="contribution-card-copy">
                  Download your kept recordings now, or go back to the sound library.
                </p>
              </section>
            }
          >
            {(item) => (
              <section class="contribution-card current-contribution-step contribution-session-recorder">
                <p class="eyebrow">Current word</p>
                <div class="contribution-word-heading">
                  <div>
                    <h3>{item().word.written}</h3>
                    <p class="ipa-text">{item().word.ipa}</p>
                  </div>
                </div>

                <dl class="contribution-summary compact">
                  <div>
                    <dt>Language</dt>
                    <dd>{props.language.name}</dd>
                  </div>
                  <div>
                    <dt>Sounds</dt>
                    <dd>{item().word.phonemeIds.join(", ")}</dd>
                  </div>
                </dl>

                <ContributionFormantTargetChart
                  language={props.language}
                  word={item().word}
                  recordingUrl={recorder.recordingUrl()}
                  recordingProgress={recordingPreviewProgress()}
                />

                <RecordingTimeline
                  status={recorder.status()}
                  timelineElapsedMs={recorder.timelineElapsedMs()}
                  countdownProgressPercent={recorder.countdownProgressPercent()}
                  recordingProgressPercent={recorder.recordingProgressPercent()}
                  message={recorder.timelineMessage()}
                />

                <Show when={recorder.recorderAvailable()} fallback={
                  <p class="error-message">Recording is not available in this browser.</p>
                }>
                  <div class="recorder-actions">
                    <Show
                      when={recorder.recordingBlob()}
                      fallback={
                        <button
                          class="primary-button"
                          type="button"
                          disabled={recorder.recordingInProgress()}
                          onClick={() => void startRecording()}
                        >
                          {recorder.recordButtonText()}
                        </button>
                      }
                    >
                      <button class="recording-preview-button" type="button" onClick={() => void playRecordingPreview()}>
                        {recordingPreviewRequested() ? "Replay" : "Play"}
                      </button>
                      <button
                        class="primary-button keep-next-button"
                        type="button"
                        disabled={!recordingPreviewPlayed()}
                        onClick={keepAndNext}
                      >
                        Keep and next
                      </button>
                      <button class="contribution-retry-button" type="button" onClick={() => void retryRecording()}>
                        Retry
                      </button>
                    </Show>
                    <button
                      class="text-button compact"
                      type="button"
                      disabled={!canUndoLastKeptRecording()}
                      onClick={undoLastKeptRecording}
                    >
                      Undo
                    </button>
                    <button class="text-button compact" type="button" disabled={recorder.recordingInProgress()} onClick={skipCurrent}>
                      Skip
                    </button>
                  </div>
                </Show>

                <Show when={recorder.recordingUrl()}>
                  {(url) => (
                    <div class="recording-preview">
                      <p>Listen back before keeping this recording.</p>
                      <audio
                        class="recording-preview-audio"
                        preload="auto"
                        ref={setRecordingPreviewAudioElement}
                        src={url()}
                        onLoadedMetadata={(event) => recordingPreviewTracker.update(event.currentTarget, "loadedmetadata")}
                        onLoadedData={(event) => recordingPreviewTracker.update(event.currentTarget, "loadeddata")}
                        onCanPlay={(event) => recordingPreviewTracker.update(event.currentTarget, "canplay")}
                        onPlay={(event) => recordingPreviewTracker.start(event.currentTarget, "play")}
                        onPlaying={(event) => recordingPreviewTracker.start(event.currentTarget, "playing")}
                        onTimeUpdate={(event) => recordingPreviewTracker.update(event.currentTarget, "timeupdate")}
                        onSeeking={(event) => recordingPreviewTracker.update(event.currentTarget, "seeking")}
                        onSeeked={(event) => recordingPreviewTracker.update(event.currentTarget, "seeked")}
                        onWaiting={(event) => recordingPreviewTracker.note(event.currentTarget, "waiting")}
                        onStalled={(event) => recordingPreviewTracker.note(event.currentTarget, "stalled")}
                        onSuspend={(event) => recordingPreviewTracker.note(event.currentTarget, "suspend")}
                        onError={(event) => recordingPreviewTracker.note(event.currentTarget, "error")}
                        onPause={(event) => recordingPreviewTracker.pause(event.currentTarget)}
                        onEnded={() => recordingPreviewTracker.end()}
                      />
                    </div>
                  )}
                </Show>
                <Show when={pageError()}>
                  {(message) => <p class="error-message">{message()}</p>}
                </Show>
              </section>
            )}
          </Show>

        </div>

        <aside class="contribution-card contribution-session-sidebar">
          <p class="eyebrow">Session</p>
          <h3>Progress</h3>
          <div class="contribution-session-stats">
            <div><strong>{keptRecordings().length}</strong><span>kept</span></div>
            <div><strong>{skippedWordIds().length}</strong><span>skipped</span></div>
            <div><strong>{remainingItems().length}</strong><span>remaining</span></div>
          </div>

          <label class="field-label">
            Licence
            <select value={licence()} onInput={(event) => updateLicence(event.currentTarget.value as ContributionLicence)}>
              <option value="CC0-1.0">CC0 1.0 public domain dedication</option>
              <option value="CC-BY-4.0">CC BY 4.0 attribution</option>
            </select>
          </label>
          <label class="field-label">
            Name {requiresAttributionName() ? <span>(required for CC BY 4.0)</span> : <span>(optional for CC0)</span>}
            <input
              type="text"
              value={speakerName()}
              onInput={(event) => updateSpeakerName(event.currentTarget.value)}
              placeholder="How you want to be credited"
            />
          </label>
          <label class="field-label">
            Accent or region <span>(optional)</span>
            <input
              type="text"
              value={accent()}
              onInput={(event) => updateAccent(event.currentTarget.value)}
              placeholder="e.g. Belgian French"
            />
          </label>
          <button class="primary-button" type="button" disabled={!canDownload() || downloadStatus() !== "idle"} onClick={() => void downloadBatch()}>
            {downloadButtonText()}
          </button>
          <Show when={requiresAttributionName() && speakerName().trim().length === 0}>
            <p class="muted">CC BY 4.0 needs a name for attribution. CC0 does not.</p>
          </Show>

          <div class="upcoming-contribution-list">
            <h4>Upcoming words</h4>
            <Show when={upcomingItems().length > 0} fallback={<p class="muted">No upcoming words.</p>}>
              <For each={upcomingItems()}>
                {(item) => (
                  <div class="upcoming-contribution-word">
                    <strong>{item.word.written}</strong>
                    <span class="ipa-text">{item.word.ipa}</span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </aside>

        <section class={`contribution-card contribution-send-card${downloadStatus() === "downloaded" ? " current-contribution-step" : ""}`}>
          <p class="eyebrow">Send your batch</p>
          <h3>Send your contribution</h3>
          <p class="contribution-card-copy">
            Send the downloaded ZIP to bovine3dom on <a href="https://github.com/bovine3dom/vowel_trowel/issues/new" target="_blank" rel="noreferrer">GitHub</a>,
            or however you usually talk to him.
          </p>
        </section>
      </div>
    </section>
  );
}

function ContributionFormantTargetChart(props: {
  language: LanguageDataset;
  word: WordEntry;
  recordingUrl?: string | null;
  recordingProgress?: number;
}) {
  let canvas: HTMLCanvasElement | undefined;
  let lastDrawDebugKey = "";
  const [recordingSpectrogram, setRecordingSpectrogram] = createSignal<PrecomputedSpectrogram | null>(null);
  const targets = createMemo((): FormantTarget[] => formantTargetsForWord(props.word, props.language));
  const debugLabel = () => `${props.language.id}:${props.word.id}`;
  const draw = () => {
    const currentTargets = targets();
    const spectrogram = recordingSpectrogram();
    const formants = spectrogram?.formants;
    const progress = props.recordingProgress ?? 0;

    paintFormantTargetChart(canvas, currentTargets, formants, progress);

    const drawDebugKey = [
      Boolean(canvas?.isConnected),
      currentTargets.length,
      Boolean(spectrogram),
      Boolean(formants),
      Math.floor(progress * 20),
    ].join(":");

    if (drawDebugKey !== lastDrawDebugKey && (props.recordingUrl || progress > 0 || spectrogram)) {
      lastDrawDebugKey = drawDebugKey;
      debugContributionAudio("formant chart draw", {
        label: debugLabel(),
        canvasConnected: Boolean(canvas?.isConnected),
        targetCount: currentTargets.length,
        hasSpectrogram: Boolean(spectrogram),
        hasFormants: Boolean(formants),
        formantPoints: formants?.points.length ?? 0,
        progress: Number(progress.toFixed(3)),
      });
    }
  };

  createEffect(() => {
    const recordingUrl = props.recordingUrl;

    setRecordingSpectrogram(null);
    debugContributionAudio("formant recording url changed", {
      label: debugLabel(),
      url: recordingUrl ? describeDebugAudioSource(recordingUrl) : null,
    });

    if (!recordingUrl) {
      return;
    }

    let cancelled = false;
    let completed = false;
    const decodeStartedAt = performance.now();

    debugContributionAudio("formant decode start", {
      label: debugLabel(),
      url: describeDebugAudioSource(recordingUrl),
    });

    void getPrecomputedSpectrogram(recordingUrl)
      .then((spectrogram) => {
        completed = true;

        if (!cancelled) {
          const formants = spectrogram.formants;

          debugContributionAudio("formant decode success", {
            label: debugLabel(),
            duration: Number(spectrogram.duration.toFixed(3)),
            decodeMs: Math.round(performance.now() - decodeStartedAt),
            hasFormants: Boolean(formants),
            formantPoints: formants?.points.length ?? 0,
            validFormantPoints: formants?.points.filter((point) => point.f1 !== null && point.f2 !== null).length ?? 0,
          });
          setRecordingSpectrogram(spectrogram);
        }
      })
      .catch((error) => {
        completed = true;

        if (!cancelled) {
          debugContributionAudio("formant decode failed", {
            label: debugLabel(),
            error: error instanceof Error ? error.message : String(error),
          });
          setRecordingSpectrogram(null);
        }
      });

    onCleanup(() => {
      cancelled = true;
      if (!completed) {
        debugContributionAudio("formant decode cancelled", {
          label: debugLabel(),
          url: describeDebugAudioSource(recordingUrl),
        });
      }
    });
  });

  createEffect(draw);

  onMount(() => {
    draw();

    if (!canvas || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(draw);

    observer.observe(canvas);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="contribution-formant-target">
      <div class="formant-legend contribution-formant-legend" aria-hidden="true">
        <span>Target vowel space</span>
      </div>
      <div class="formant-frame contribution-formant-frame">
        <canvas
          ref={(element) => { canvas = element; }}
          aria-label="Target vowel formant positions"
        />
      </div>
      <Show when={targets().length > 0} fallback={<p class="muted">No vowel target is mapped for this word yet.</p>}>
        <p class="contribution-formant-caption">
          Aim for the highlighted vowel sound{targets().length === 1 ? "" : "s"}: {targets().map((target) => target.label).join(", ")}.
        </p>
      </Show>
    </div>
  );
}

function ContributionPage(props: {
  language: LanguageDataset;
  word: WordEntry;
  onBack: () => void;
  onContributionDownloaded: (wordIds: readonly string[]) => void;
  onContributionSpeakerNameChange: (speakerName: string) => void;
}) {
  const savedContributionDetails = loadContributionDetails();
  const recorder = createContributionRecorder(() => props.word.written);
  const [licence, setLicence] = createSignal<ContributionLicence>(savedContributionDetails.licence);
  const [speakerName, setSpeakerName] = createSignal(savedContributionDetails.speakerName);
  const [accent, setAccent] = createSignal(savedContributionDetails.accent);
  const [downloadStatus, setDownloadStatus] = createSignal<ContributionDownloadStatus>("idle");
  const [downloadError, setDownloadError] = createSignal<string | null>(null);
  const [recordingPreviewProgress, setRecordingPreviewProgress] = createSignal(0);

  const requiresAttributionName = createMemo(() => licence() === "CC-BY-4.0");
  const canDownload = createMemo(() =>
    Boolean(recorder.recordingBlob()) && (!requiresAttributionName() || speakerName().trim().length > 0)
  );
  const downloadButtonText = createMemo(() => {
    if (downloadStatus() === "downloading") {
      return "Downloading...";
    }

    if (downloadStatus() === "downloaded") {
      return "Downloaded";
    }

    return "Download contribution zip";
  });
  const pageError = createMemo(() => recorder.error() ?? downloadError());
  const recordingStepActive = createMemo(() => !recorder.recordingBlob() || recorder.recordingInProgress());
  const detailsStepActive = createMemo(() => Boolean(recorder.recordingBlob()) && downloadStatus() !== "downloaded");
  const sendStepActive = createMemo(() => downloadStatus() === "downloaded");

  createEffect(() => {
    saveContributionDetails({
      schemaVersion: 1,
      licence: licence(),
      speakerName: speakerName().trim(),
      accent: accent().trim(),
    });
  });

  const recordingPreviewTracker = createAudioPlaybackProgressTracker(
    "single-preview",
    setRecordingPreviewProgress,
  );

  createEffect(() => {
    recorder.recordingUrl();
    recordingPreviewTracker.stop();
    setRecordingPreviewProgress(0);
  });

  onCleanup(recordingPreviewTracker.stop);

  const startRecording = async () => {
    setDownloadStatus("idle");
    setDownloadError(null);
    await recorder.startRecording();
  };

  const discardAndRecordAgain = async () => {
    setDownloadStatus("idle");
    setDownloadError(null);
    await recorder.discardAndRecordAgain();
  };

  const updateLicence = (nextLicence: ContributionLicence) => {
    setLicence(nextLicence);
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const updateSpeakerName = (nextSpeakerName: string) => {
    setSpeakerName(nextSpeakerName);
    props.onContributionSpeakerNameChange(nextSpeakerName.trim());
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const updateAccent = (nextAccent: string) => {
    setAccent(nextAccent);
    setDownloadStatus("idle");
    setDownloadError(null);
  };

  const downloadBundle = async () => {
    const blob = recorder.recordingBlob();

    if (!blob || !canDownload() || downloadStatus() === "downloading") {
      return;
    }

    setDownloadStatus("downloading");
    setDownloadError(null);

    try {
      const recordingFilename = `recording.${extensionForMimeType(blob.type)}`;
      const manifest = createContributionManifest({
        language: props.language,
        word: props.word,
        recordingFilename,
        mimeType: blob.type || "audio/webm",
        recordingSize: blob.size,
        licence: licence(),
        speakerName: speakerName().trim(),
        accent: accent().trim(),
      });
      const archive = zipSync({
        "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
        [recordingFilename]: new Uint8Array(await blob.arrayBuffer()),
      }, { level: 0 });

      downloadBlob(
        new Blob([archive], { type: "application/zip" }),
        `${manifest.id}.zip`,
      );
      props.onContributionDownloaded([props.word.id]);
      setDownloadStatus("downloaded");
    } catch (downloadError) {
      setDownloadStatus("idle");
      setDownloadError(downloadError instanceof Error ? downloadError.message : "Could not download contribution.");
    }
  };

  return (
    <section class="content-panel contribution-panel">
      <div class="contribution-nav">
        <button class="text-button compact" type="button" onClick={props.onBack}>
          Back to sound library
        </button>
      </div>

      <div class="panel-heading contribution-heading">
        <p class="eyebrow">Contribute audio</p>
        <h2>Record “{props.word.written}”</h2>
        <p>
          Say <strong>{props.word.written}</strong> <span class="ipa-text">{props.word.ipa}</span> clearly once.
          Download the ZIP when you are happy with the recording.
        </p>
      </div>

      <dl class="contribution-summary">
        <div>
          <dt>Language</dt>
          <dd>{props.language.name}</dd>
        </div>
        <div>
          <dt>Word</dt>
          <dd>{props.word.written}</dd>
        </div>
        <div>
          <dt>IPA</dt>
          <dd class="ipa-text">{props.word.ipa}</dd>
        </div>
        <div>
          <dt>Sounds</dt>
          <dd>{props.word.phonemeIds.join(", ")}</dd>
        </div>
      </dl>

      <div class="contribution-grid">
        <section class={`contribution-card recorder-card${recordingStepActive() ? " current-contribution-step" : ""}`}>
          <p class="eyebrow">Step 1</p>
          <h3>Record your sample</h3>
          <p class="contribution-card-copy">Use a quiet room. After the countdown, say the word once, naturally.</p>
          <ContributionFormantTargetChart
            language={props.language}
            word={props.word}
            recordingUrl={recorder.recordingUrl()}
            recordingProgress={recordingPreviewProgress()}
          />
          <RecordingTimeline
            status={recorder.status()}
            timelineElapsedMs={recorder.timelineElapsedMs()}
            countdownProgressPercent={recorder.countdownProgressPercent()}
            recordingProgressPercent={recorder.recordingProgressPercent()}
            message={recorder.timelineMessage()}
          />
          <Show when={recorder.recorderAvailable()} fallback={
            <p class="error-message">Recording is not available in this browser.</p>
          }>
            <div class="recorder-actions">
              <Show
                when={recorder.recordingBlob()}
                fallback={
                  <button
                    class="primary-button"
                    type="button"
                    disabled={recorder.recordingInProgress()}
                    onClick={() => void startRecording()}
                  >
                    {recorder.recordButtonText()}
                  </button>
                }
              >
                <button class="contribution-retry-button" type="button" onClick={() => void discardAndRecordAgain()}>
                  Discard and record again
                </button>
              </Show>
            </div>
          </Show>
          <Show when={recorder.recordingUrl()}>
            {(url) => (
              <div class="recording-preview">
                <p>Listen back before downloading.</p>
                <audio
                  controls
                  preload="auto"
                  ref={loadRecordingPreviewAudio}
                  src={url()}
                  onLoadedMetadata={(event) => recordingPreviewTracker.update(event.currentTarget, "loadedmetadata")}
                  onLoadedData={(event) => recordingPreviewTracker.update(event.currentTarget, "loadeddata")}
                  onCanPlay={(event) => recordingPreviewTracker.update(event.currentTarget, "canplay")}
                  onPlay={(event) => recordingPreviewTracker.start(event.currentTarget, "play")}
                  onPlaying={(event) => recordingPreviewTracker.start(event.currentTarget, "playing")}
                  onTimeUpdate={(event) => recordingPreviewTracker.update(event.currentTarget, "timeupdate")}
                  onSeeking={(event) => recordingPreviewTracker.update(event.currentTarget, "seeking")}
                  onSeeked={(event) => recordingPreviewTracker.update(event.currentTarget, "seeked")}
                  onWaiting={(event) => recordingPreviewTracker.note(event.currentTarget, "waiting")}
                  onStalled={(event) => recordingPreviewTracker.note(event.currentTarget, "stalled")}
                  onSuspend={(event) => recordingPreviewTracker.note(event.currentTarget, "suspend")}
                  onError={(event) => recordingPreviewTracker.note(event.currentTarget, "error")}
                  onPause={(event) => recordingPreviewTracker.pause(event.currentTarget)}
                  onEnded={() => recordingPreviewTracker.end()}
                />
              </div>
            )}
          </Show>
          <Show when={pageError()}>
            {(message) => <p class="error-message">{message()}</p>}
          </Show>
        </section>

        <section class={`contribution-card contribution-form-card${detailsStepActive() ? " current-contribution-step" : ""}`}>
          <p class="eyebrow">Step 2</p>
          <h3>Licence and download</h3>
          <p class="contribution-card-copy">CC0 is easiest. Pick CC BY 4.0 if you require your name to be attached.</p>
          <label class="field-label">
            Licence
            <select value={licence()} onInput={(event) => updateLicence(event.currentTarget.value as ContributionLicence)}>
              <option value="CC0-1.0">CC0 1.0 public domain dedication</option>
              <option value="CC-BY-4.0">CC BY 4.0 attribution</option>
            </select>
          </label>
          <label class="field-label">
            Name {requiresAttributionName() ? <span>(required for CC BY 4.0)</span> : <span>(optional for CC0)</span>}
            <input
              type="text"
              value={speakerName()}
              onInput={(event) => updateSpeakerName(event.currentTarget.value)}
              placeholder="How you want to be credited"
            />
          </label>
          <label class="field-label">
            Accent or region <span>(optional)</span>
            <input
              type="text"
              value={accent()}
              onInput={(event) => updateAccent(event.currentTarget.value)}
              placeholder="e.g. Belgian French"
            />
          </label>
          <button class="primary-button" type="button" disabled={!canDownload() || downloadStatus() !== "idle"} onClick={() => void downloadBundle()}>
            {downloadButtonText()}
          </button>
          <Show when={requiresAttributionName() && speakerName().trim().length === 0}>
            <p class="muted">CC BY 4.0 needs a name for attribution. CC0 does not.</p>
          </Show>
        </section>

        <section class={`contribution-card contribution-send-card${sendStepActive() ? " current-contribution-step" : ""}`}>
          <p class="eyebrow">Step 3</p>
          <h3>Send your contribution</h3>
          <p class="contribution-card-copy">
            Send the downloaded ZIP to bovine3dom on <a href="https://github.com/bovine3dom/vowel_trowel/issues/new" target="_blank" rel="noreferrer">GitHub</a>,
            or however you usually talk to him.
          </p>
        </section>
      </div>
    </section>
  );
}

function VoicePanel(props: {
  voices: readonly SpeechSynthesisVoice[];
  activeVoice: SpeechSynthesisVoice | undefined;
  selectedVoiceURI: string | null;
  languageName: string;
  preferredLangs: readonly string[];
  onSelect: (voiceURI: string) => void;
}) {
  return (
    <section class="voice-panel">
      <h3>Browser voice</h3>
      <p>
        If your browser offers a better {props.languageName} voice, select it here.
      </p>
      <Show
        when={props.voices.length > 0}
        fallback={<p class="muted">No matching browser voices detected yet.</p>}
      >
        <label class="voice-select-label">
          <span>Browser voice</span>
          <select
            value={props.selectedVoiceURI ?? ""}
            onInput={(event) => props.onSelect(event.currentTarget.value)}
          >
            <option value="">Automatic choice</option>
            <For each={props.voices}>
              {(voice) => (
                <option value={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <p class="voice-current">
        Current: {props.activeVoice ? `${props.activeVoice.name} (${props.activeVoice.lang})` : "browser default"}
      </p>
      <p class="muted">
        Real recordings are still best for close sound contrasts.
      </p>
    </section>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div class="metric-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function SpectrogramPanel(props: { visualization: PlaybackVisualizationState }) {
  let canvas: HTMLCanvasElement | undefined;
  let formantCanvas: HTMLCanvasElement | undefined;
  let stopSpectrogram: (() => void) | undefined;
  let paintedStateId: number | undefined;
  let paintedExpanded = false;
  let revealedColumn = 0;
  const [expanded, setExpanded] = createSignal(false);

  const stopDrawing = () => {
    stopSpectrogram?.();
    stopSpectrogram = undefined;
  };

  createEffect(() => {
    const visualization = props.visualization;
    const isExpanded = expanded();

    if (!canvas) {
      return;
    }

    const isNewSelection = paintedStateId !== visualization.id;

    if (isNewSelection || paintedExpanded !== isExpanded) {
      paintedStateId = visualization.id;
      paintedExpanded = isExpanded;
      revealedColumn = 0;
      paintSpectrogramBase(canvas, visualization);
      paintFormantBase(formantCanvas, visualization);
    }

    stopDrawing();

    if (visualization.status === "playing" && visualization.spectrogram) {
      stopSpectrogram = drawPrecomputedSpectrogram(canvas, formantCanvas, visualization, {
        get: () => revealedColumn,
        set: (column) => { revealedColumn = column; },
      });
      return;
    }

    if (visualization.status === "ended" && visualization.spectrogram) {
      revealedColumn = paintSpectrogramToProgress(canvas, visualization, 1, revealedColumn);
      paintFormantsToProgress(formantCanvas, visualization, 1);
    }
  });

  createEffect(() => {
    if (!expanded()) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    onCleanup(() => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    });
  });

  onCleanup(stopDrawing);

  return (
    <section class={expanded() ? "spectrogram-panel expanded" : "spectrogram-panel"} aria-label="Spectrogram display">
      <div class="spectrogram-heading">
        <div>
          <p class="eyebrow">Sound picture</p>
          <h3>Spectrogram</h3>
        </div>
        <div class="spectrogram-heading-actions">
          <button
            class="text-button compact spectrogram-maximise"
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded()}
          >
            {expanded() ? "Close" : "Maximise"}
          </button>
        </div>
      </div>
      <div class="spectrogram-frame">
        <canvas
          ref={(element) => { canvas = element; }}
          aria-label="Audio spectrogram"
        />
      </div>
      <div class="formant-legend" aria-hidden="true">
        <span class="eyebrow">Approximate formant path</span>
      </div>
      <div class="formant-frame">
        <canvas
          ref={(element) => { formantCanvas = element; }}
          aria-label="Estimated F1 and F2 formant path"
        />
      </div>
      <div class="spectrogram-meta">
        <div>
          <strong>{props.visualization.label}</strong>
          <span>{props.visualization.detail}</span>
        </div>
        <div class="spectrogram-actions">
          <AudioFeedbackButton path={props.visualization.feedbackPath} />
          <button
            class="small-button spectrogram-replay"
            type="button"
            disabled={!props.visualization.replay}
            onClick={() => void props.visualization.replay?.().catch(() => undefined)}
          >
            Replay
          </button>
        </div>
      </div>
    </section>
  );
}

function AudioFeedbackButton(props: { path: string | undefined }) {
  let resetTimeout: number | undefined;
  const [copied, setCopied] = createSignal(false);

  const copyTrackLink = async (event: MouseEvent) => {
    event.stopPropagation();

    if (!props.path) {
      return;
    }

    try {
      await navigator.clipboard.writeText(props.path);
      setCopied(true);
    } catch {
      setCopied(false);
    }

    if (resetTimeout !== undefined) {
      window.clearTimeout(resetTimeout);
    }

    resetTimeout = window.setTimeout(() => setCopied(false), 2000);
  };

  onCleanup(() => {
    if (resetTimeout !== undefined) {
      window.clearTimeout(resetTimeout);
    }
  });

  return (
    <Show when={props.path}>
      <button
        class="audio-feedback-button"
        type="button"
        title={copied() ? "Track link copied" : "Copy track link"}
        aria-label="Copy track link"
        onClick={(event) => void copyTrackLink(event)}
      >
        <Show when={copied()} fallback={
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
            <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
          </svg>
        }>
          <span aria-live="polite">Track link copied</span>
        </Show>
      </button>
    </Show>
  );
}

function paintSpectrogramBase(canvas: HTMLCanvasElement, visualization: PlaybackVisualizationState): void {
  const { ctx, width, height } = prepareSpectrogramCanvas(canvas);

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, width, height);
  paintSpectrogramGrid(ctx, width, height);

  if (visualization.mode === "voice") {
    paintVoicePattern(ctx, width, height);
    return;
  }

  if (visualization.mode === "recording" && !visualization.spectrogram) {
    paintUnavailablePattern(ctx, width, height);
    return;
  }

  if (visualization.status === "idle") {
    paintIdlePattern(ctx, width, height);
  }
}

function drawPrecomputedSpectrogram(
  canvas: HTMLCanvasElement,
  formantCanvas: HTMLCanvasElement | undefined,
  visualization: PlaybackVisualizationState,
  revealedColumn: { get: () => number; set: (column: number) => void },
): () => void {
  let frameId: number | undefined;
  let active = true;
  const startedAt = performance.now();

  const draw = () => {
    if (!active) {
      return;
    }

    const { resized } = prepareSpectrogramCanvas(canvas);

    if (resized) {
      revealedColumn.set(0);
      paintSpectrogramBase(canvas, visualization);
    }

    const progress = getSpectrogramProgress(visualization, startedAt);
    const nextColumn = paintSpectrogramToProgress(canvas, visualization, progress, revealedColumn.get());

    revealedColumn.set(nextColumn);
    paintFormantsToProgress(formantCanvas, visualization, progress);

    frameId = requestAnimationFrame(draw);
  };

  frameId = requestAnimationFrame(draw);

  return () => {
    active = false;

    if (frameId !== undefined) {
      cancelAnimationFrame(frameId);
    }
  };
}

function paintSpectrogramToProgress(
  canvas: HTMLCanvasElement,
  visualization: PlaybackVisualizationState,
  progress: number,
  currentColumn: number,
): number {
  if (!visualization.spectrogram) {
    return currentColumn;
  }

  const { ctx, width, height } = prepareSpectrogramCanvas(canvas);
  const clampedProgress = Math.max(0, Math.min(1, progress));
  const targetColumn = Math.max(currentColumn, Math.min(width, Math.ceil(clampedProgress * width)));

  if (targetColumn <= currentColumn) {
    return currentColumn;
  }

  paintSpectrogramSlice(ctx, width, currentColumn, targetColumn, height, visualization.spectrogram);

  return targetColumn;
}

function paintSpectrogramSlice(
  ctx: CanvasRenderingContext2D,
  width: number,
  fromX: number,
  toX: number,
  height: number,
  spectrogram: PrecomputedSpectrogram,
): void {
  const image = getRenderedSpectrogram(spectrogram);
  const sourceStart = Math.floor((fromX / Math.max(1, width)) * image.width);
  const sourceEnd = Math.max(sourceStart + 1, Math.ceil((toX / Math.max(1, width)) * image.width));
  const sourceWidth = Math.min(image.width - sourceStart, sourceEnd - sourceStart);
  const targetWidth = Math.max(1, toX - fromX);

  if (sourceWidth <= 0) {
    return;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    image,
    sourceStart,
    0,
    sourceWidth,
    image.height,
    fromX,
    0,
    targetWidth,
    height,
  );
}

function paintFormantBase(canvas: HTMLCanvasElement | undefined, visualization: PlaybackVisualizationState): void {
  if (!canvas?.isConnected) {
    return;
  }

  const { ctx, width, height } = prepareFormantCanvas(canvas);
  const formants = visualization.spectrogram?.formants;
  const range = formantChartRange(formants);

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, width, height);
  paintFormantGrid(ctx, width, height, range);
  paintReferenceVowels(ctx, width, height, range);

  if (formants) {
    return;
  }

  if (visualization.mode === "recording" && visualization.spectrogram) {
    paintFormantMessage(ctx, width, height, "No stable F1/F2 estimate for this recording");
    return;
  }

  if (visualization.mode === "voice") {
    paintFormantMessage(ctx, width, height, "Formants need a recording, not browser voice");
    return;
  }

  paintFormantMessage(ctx, width, height, "F1/F2 trace appears here for recordings");
}

function paintFormantsToProgress(
  canvas: HTMLCanvasElement | undefined,
  visualization: PlaybackVisualizationState,
  progress: number,
): void {
  if (!canvas?.isConnected) {
    return;
  }

  paintFormantBase(canvas, visualization);

  const formants = visualization.spectrogram?.formants;

  if (!formants) {
    return;
  }

  const { ctx, width, height } = prepareFormantCanvas(canvas);
  const clampedProgress = Math.max(0, Math.min(1, progress));

  paintFormantPath(ctx, formants, clampedProgress, width, height);
}

interface FormantChartRange {
  minF1: number;
  maxF1: number;
  minF2: number;
  maxF2: number;
}

interface FormantTarget {
  id: PhonemeId;
  label: string;
  f1: number;
  f2: number;
  endF1?: number;
  endF2?: number;
  style?: FormantPathStyle;
}

interface FormantTargetPathPoint {
  label: string;
  f1: number;
  f2: number;
}

interface FormantTargetPath {
  id: string;
  label: string;
  points: readonly FormantTargetPathPoint[];
  style?: FormantPathStyle;
}

interface FormantLabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

type FormantPosition = Pick<FormantTarget, "f1" | "f2" | "endF1" | "endF2">;

interface FormantPathStyle {
  outerStroke: string;
  middleStroke: string;
  innerStroke: string;
  pointFill: string;
  pointStroke: string;
  pointOutline: string;
  targetLabelFill?: string;
  targetLabelStroke?: string;
  targetLabelText?: string;
  componentLabelFill?: string;
  componentLabelStroke?: string;
  componentLabelText?: string;
  mainLabelFill?: string;
  mainLabelStroke?: string;
  mainLabelText?: string;
  labelPreference?: "above" | "below";
}

const RECORDED_FORMANT_PATH_STYLE: FormantPathStyle = {
  outerStroke: "rgba(255, 253, 250, 0.92)",
  middleStroke: "rgba(243, 185, 69, 0.72)",
  innerStroke: "#264f87",
  pointFill: "#f3b945",
  pointStroke: "#fffdfa",
  pointOutline: "#264f87",
};

const LIVE_FORMANT_PATH_STYLE: FormantPathStyle = {
  outerStroke: "rgba(255, 253, 250, 0.95)",
  middleStroke: "rgba(32, 32, 32, 0.28)",
  innerStroke: "#b83252",
  pointFill: "#b83252",
  pointStroke: "#fffdfa",
  pointOutline: "#202020",
};

const TARGET_FORMANT_PATH_STYLE: FormantPathStyle = {
  outerStroke: "rgba(255, 253, 250, 0.96)",
  middleStroke: "rgba(243, 185, 69, 0.92)",
  innerStroke: "#264f87",
  pointFill: "rgba(243, 185, 69, 0.94)",
  pointStroke: "#fffdfa",
  pointOutline: "#8a6814",
  targetLabelFill: "rgba(243, 185, 69, 0.94)",
  targetLabelStroke: "#8a6814",
  targetLabelText: "#202020",
  componentLabelFill: "#8a6814",
  componentLabelStroke: "#6f5410",
  componentLabelText: "#fffdfa",
  mainLabelFill: "rgba(248, 240, 213, 0.96)",
  mainLabelStroke: "#8a6814",
  mainLabelText: "#202020",
  labelPreference: "above",
};

const WORD_FORMANT_PATH_STYLE: FormantPathStyle = {
  outerStroke: "rgba(255, 253, 250, 0.96)",
  middleStroke: "rgba(232, 214, 244, 0.94)",
  innerStroke: "#74448c",
  pointFill: "#fffdfa",
  pointStroke: "#fffdfa",
  pointOutline: "#74448c",
  componentLabelFill: "rgba(255, 253, 250, 0.92)",
  componentLabelStroke: "rgba(116, 68, 140, 0.66)",
  componentLabelText: "#74448c",
  mainLabelFill: "rgba(232, 214, 244, 0.96)",
  mainLabelStroke: "#74448c",
  mainLabelText: "#202020",
  labelPreference: "below",
};

const FORMANT_CONTRAST_CHART_STYLES: readonly { target: FormantPathStyle; word: FormantPathStyle }[] = [
  {
    target: {
      outerStroke: "rgba(255, 253, 250, 0.96)",
      middleStroke: "rgba(183, 206, 242, 0.96)",
      innerStroke: "#2f5e9e",
      pointFill: "#264f87",
      pointStroke: "#fffdfa",
      pointOutline: "#1f3f6d",
      targetLabelFill: "#264f87",
      targetLabelStroke: "#1f3f6d",
      targetLabelText: "#fffdfa",
      componentLabelFill: "#264f87",
      componentLabelStroke: "#1f3f6d",
      componentLabelText: "#fffdfa",
      mainLabelFill: "rgba(231, 238, 252, 0.96)",
      mainLabelStroke: "#2f5e9e",
      mainLabelText: "#202020",
      labelPreference: "above",
    },
    word: {
      outerStroke: "rgba(255, 253, 250, 0.96)",
      middleStroke: "rgba(231, 238, 252, 0.96)",
      innerStroke: "rgba(47, 94, 158, 0.72)",
      pointFill: "#e7eefc",
      pointStroke: "#fffdfa",
      pointOutline: "#2f5e9e",
      componentLabelFill: "rgba(231, 238, 252, 0.94)",
      componentLabelStroke: "rgba(47, 94, 158, 0.66)",
      componentLabelText: "#264f87",
      mainLabelFill: "rgba(231, 238, 252, 0.96)",
      mainLabelStroke: "#2f5e9e",
      mainLabelText: "#202020",
      labelPreference: "below",
    },
  },
  {
    target: {
      outerStroke: "rgba(255, 253, 250, 0.96)",
      middleStroke: "rgba(240, 197, 178, 0.96)",
      innerStroke: "#a24f2f",
      pointFill: "#853f27",
      pointStroke: "#fffdfa",
      pointOutline: "#6c321e",
      targetLabelFill: "#853f27",
      targetLabelStroke: "#6c321e",
      targetLabelText: "#fffdfa",
      componentLabelFill: "#853f27",
      componentLabelStroke: "#6c321e",
      componentLabelText: "#fffdfa",
      mainLabelFill: "rgba(248, 232, 223, 0.96)",
      mainLabelStroke: "#a24f2f",
      mainLabelText: "#202020",
      labelPreference: "above",
    },
    word: {
      outerStroke: "rgba(255, 253, 250, 0.96)",
      middleStroke: "rgba(248, 232, 223, 0.96)",
      innerStroke: "rgba(162, 79, 47, 0.72)",
      pointFill: "#f8e8df",
      pointStroke: "#fffdfa",
      pointOutline: "#a24f2f",
      componentLabelFill: "rgba(248, 232, 223, 0.94)",
      componentLabelStroke: "rgba(162, 79, 47, 0.66)",
      componentLabelText: "#853f27",
      mainLabelFill: "rgba(248, 232, 223, 0.96)",
      mainLabelStroke: "#a24f2f",
      mainLabelText: "#202020",
      labelPreference: "below",
    },
  },
];

const APPROXIMATE_PHONEME_FORMANTS: Record<string, FormantPosition> = {
  "fr-i": { f1: 280, f2: 2400 },
  "fr-y": { f1: 300, f2: 1700 },
  "fr-u": { f1: 320, f2: 850 },
  "fr-e": { f1: 390, f2: 2200 },
  "fr-epsilon": { f1: 550, f2: 2000 },
  "fr-schwa": { f1: 550, f2: 1500 },
  "fr-eu": { f1: 400, f2: 1700 },
  "fr-oe": { f1: 600, f2: 1600 },
  "fr-o": { f1: 420, f2: 900 },
  "fr-open-o": { f1: 600, f2: 1000 },
  "fr-a": { f1: 850, f2: 1500 },
  "fr-back-a": { f1: 850, f2: 1100 },
  "fr-an": { f1: 800, f2: 1100 },
  "fr-in": { f1: 550, f2: 1900 },
  "fr-on": { f1: 600, f2: 950 },
  "fr-un": { f1: 600, f2: 1550 },
  "en-gb-kit": { f1: 400, f2: 2100 },
  "en-gb-fleece": { f1: 280, f2: 2400 },
  "en-gb-happy": { f1: 320, f2: 2300 },
  "en-gb-dress": { f1: 500, f2: 2000 },
  "en-gb-trap": { f1: 700, f2: 1850 },
  "en-gb-palm": { f1: 750, f2: 1100 },
  "en-gb-strut": { f1: 650, f2: 1400 },
  "en-gb-lot": { f1: 600, f2: 950 },
  "en-gb-thought": { f1: 500, f2: 850 },
  "en-gb-foot": { f1: 430, f2: 1100 },
  "en-gb-goose": { f1: 320, f2: 850 },
  "en-gb-nurse": { f1: 500, f2: 1500 },
  "en-gb-schwa": { f1: 550, f2: 1500 },
  "en-gb-face": { f1: 430, f2: 2050, endF1: 300, endF2: 2400 },
  "en-gb-goat": { f1: 550, f2: 1500, endF1: 330, endF2: 850 },
  "en-gb-price": { f1: 850, f2: 1450, endF1: 320, endF2: 2350 },
  "en-gb-choice": { f1: 600, f2: 1000, endF1: 320, endF2: 2350 },
  "en-gb-mouth": { f1: 850, f2: 1450, endF1: 330, endF2: 850 },
  "en-gb-near": { f1: 390, f2: 2150, endF1: 550, endF2: 1500 },
  "en-gb-square": { f1: 430, f2: 2050, endF1: 550, endF2: 1500 },
  "en-gb-cure": { f1: 430, f2: 1100, endF1: 550, endF2: 1500 },
};

const APPROXIMATE_IPA_FORMANTS: Record<string, FormantPosition> = {
  "i": { f1: 280, f2: 2400 },
  "iː": { f1: 280, f2: 2400 },
  "ɪ": { f1: 400, f2: 2100 },
  "y": { f1: 300, f2: 1700 },
  "u": { f1: 320, f2: 850 },
  "uː": { f1: 320, f2: 850 },
  "ʊ": { f1: 430, f2: 1100 },
  "e": { f1: 420, f2: 2100 },
  "ɛ": { f1: 550, f2: 2000 },
  "æ": { f1: 700, f2: 1850 },
  "ø": { f1: 400, f2: 1700 },
  "œ": { f1: 600, f2: 1600 },
  "ə": { f1: 550, f2: 1500 },
  "ɜː": { f1: 500, f2: 1500 },
  "o": { f1: 420, f2: 900 },
  "ɔ": { f1: 600, f2: 1000 },
  "ɔː": { f1: 500, f2: 850 },
  "ɒ": { f1: 600, f2: 950 },
  "ʌ": { f1: 650, f2: 1400 },
  "a": { f1: 850, f2: 1500 },
  "ɑ": { f1: 850, f2: 1100 },
  "ɑː": { f1: 750, f2: 1100 },
  "ɑ̃": { f1: 800, f2: 1100 },
  "ɛ̃": { f1: 550, f2: 1900 },
  "ɔ̃": { f1: 600, f2: 950 },
  "œ̃": { f1: 600, f2: 1550 },
  "eɪ": { f1: 430, f2: 2050, endF1: 300, endF2: 2400 },
  "əʊ": { f1: 550, f2: 1500, endF1: 330, endF2: 850 },
  "aɪ": { f1: 850, f2: 1450, endF1: 320, endF2: 2350 },
  "ɔɪ": { f1: 600, f2: 1000, endF1: 320, endF2: 2350 },
  "aʊ": { f1: 850, f2: 1450, endF1: 330, endF2: 850 },
  "ɪə": { f1: 390, f2: 2150, endF1: 550, endF2: 1500 },
  "eə": { f1: 430, f2: 2050, endF1: 550, endF2: 1500 },
  "ʊə": { f1: 430, f2: 1100, endF1: 550, endF2: 1500 },
};

function formantChartRange(formants: PrecomputedSpectrogram["formants"]): FormantChartRange {
  return {
    minF1: 150,
    maxF1: 1200,
    minF2: 500,
    maxF2: Math.min(3500, formants?.maxHz ?? 3500),
  };
}

function formantTargetsForWord(word: WordEntry, sourceDataset: LanguageDataset): FormantTarget[] {
  const seen = new Set<PhonemeId>();
  const targets: FormantTarget[] = [];

  for (const phonemeId of word.phonemeIds) {
    if (seen.has(phonemeId)) {
      continue;
    }

    seen.add(phonemeId);

    const phoneme = sourceDataset.phonemes.find((candidate) => candidate.id === phonemeId);
    const target = phoneme ? formantTargetForPhoneme(phoneme) : undefined;

    if (!target) {
      continue;
    }

    targets.push(target);
  }

  return targets;
}

function formantTargetForPhoneme(phoneme: Phoneme): FormantTarget | undefined {
  if (phoneme.category !== "vowel") {
    return undefined;
  }

  const position = formantPositionForPhoneme(phoneme);

  if (!position) {
    return undefined;
  }

  return {
    id: phoneme.id,
    label: phoneme.ipa,
    ...position,
  };
}

function formantPathPointsForTarget(target: FormantTarget): FormantTargetPathPoint[] {
  const targetPath = formantTargetPathFromTarget(target);

  if (targetPath) {
    return [...targetPath.points];
  }

  return [{ label: target.label, f1: target.f1, f2: target.f2 }];
}

function formantPositionForPhoneme(phoneme: Phoneme): FormantPosition | undefined {
  return APPROXIMATE_PHONEME_FORMANTS[phoneme.id]
    ?? APPROXIMATE_IPA_FORMANTS[normalizePhonemeIpa(phoneme.ipa)];
}

function normalizePhonemeIpa(ipa: string): string {
  return ipa.replaceAll("/", "").trim();
}

function paintFormantTargetChart(
  canvas: HTMLCanvasElement | undefined,
  targets: readonly FormantTarget[],
  measuredFormants: PrecomputedSpectrogram["formants"] | undefined,
  measuredProgress: number,
  liveFormants?: FormantTrack,
  targetPaths: readonly FormantTargetPath[] = [],
): void {
  if (!canvas?.isConnected) {
    return;
  }

  const { ctx, width, height } = prepareFormantCanvas(canvas);
  const range = formantChartRange(undefined);

  ctx.fillStyle = "#f4f1ea";
  ctx.fillRect(0, 0, width, height);
  paintFormantGrid(ctx, width, height, range);
  paintReferenceVowels(ctx, width, height, range);
  const occupiedLabels: FormantLabelBox[] = [];

  if (targets.length === 0 && targetPaths.length === 0) {
    paintFormantMessage(ctx, width, height, "No mapped vowel target");
  } else {
    paintFormantTargetPaths(ctx, width, height, range, targetPaths, occupiedLabels);
    paintFormantTargets(ctx, width, height, range, targets, occupiedLabels);
  }

  if (measuredFormants && measuredProgress > 0) {
    paintFormantPath(ctx, measuredFormants, measuredProgress, width, height, range);
  }

  if (liveFormants?.points.some((point) => point.f1 !== null && point.f2 !== null)) {
    paintFormantPath(ctx, liveFormants, 1, width, height, range, LIVE_FORMANT_PATH_STYLE);
  }
}

function paintFormantGrid(ctx: CanvasRenderingContext2D, width: number, height: number, range: FormantChartRange): void {
  const area = formantPlotArea(width, height);
  const scale = formantScale(width, height);

  ctx.save();
  ctx.strokeStyle = "rgba(138, 104, 20, 0.18)";
  ctx.fillStyle = "rgba(63, 60, 55, 0.68)";
  ctx.lineWidth = Math.max(1, Math.floor(scale / 520));
  ctx.font = `700 ${Math.max(18, Math.min(42, Math.floor(scale / 20)))}px sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (const hz of [300, 600, 900]) {
    if (hz < range.minF1 || hz > range.maxF1) {
      continue;
    }

    const y = formantY(hz, range, area);

    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();
    ctx.fillText(String(hz), area.left - 7, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const hz of [500, 1000, 1500, 2000, 2500, 3000]) {
    if (hz < range.minF2 || hz > range.maxF2) {
      continue;
    }

    const x = formantX(hz, range, area);

    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x, area.bottom + 7);
  }

  ctx.strokeStyle = "rgba(32, 32, 32, 0.34)";
  ctx.beginPath();
  ctx.moveTo(area.left, area.top);
  ctx.lineTo(area.left, area.bottom);
  ctx.lineTo(area.right, area.bottom);
  ctx.stroke();
  ctx.fillStyle = "rgba(32, 32, 32, 0.72)";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("F1", area.left + 5, area.top + 5);
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText("F2", area.right - 5, area.bottom - 5);
  ctx.restore();
}

function paintFormantMessage(ctx: CanvasRenderingContext2D, width: number, height: number, message: string): void {
  ctx.save();
  ctx.fillStyle = "rgba(63, 60, 55, 0.72)";
  ctx.font = `${Math.max(14, Math.min(24, Math.floor(height / 7)))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, width / 2, height / 2);
  ctx.restore();
}

function paintReferenceVowels(ctx: CanvasRenderingContext2D, width: number, height: number, range: FormantChartRange): void {
  const area = formantPlotArea(width, height);
  const scale = formantScale(width, height);
  const labels = [
    { label: "/i/", f1: 280, f2: 2400 },
    { label: "/u/", f1: 320, f2: 850 },
    { label: "/a/", f1: 850, f2: 1450 },
  ];

  ctx.save();
  ctx.font = `800 ${Math.max(18, Math.min(38, Math.floor(scale / 18)))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const vowel of labels) {
    const x = formantX(vowel.f2, range, area);
    const y = formantY(vowel.f1, range, area);
    const radius = Math.max(14, Math.min(34, Math.floor(scale / 42)));

    ctx.fillStyle = "rgba(255, 253, 250, 0.72)";
    ctx.strokeStyle = "rgba(138, 104, 20, 0.32)";
    ctx.lineWidth = Math.max(1, Math.floor(scale / 520));
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(38, 79, 135, 0.64)";
    ctx.fillText(vowel.label, x, y + 0.5);
  }

  ctx.restore();
}

function paintFormantTargets(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  range: FormantChartRange,
  targets: readonly FormantTarget[],
  occupiedLabels: FormantLabelBox[],
): void {
  const area = formantPlotArea(width, height);
  const scale = formantScale(width, height);
  const fontSize = Math.max(18, Math.min(38, Math.floor(scale / 18)));
  const paddingX = Math.max(8, Math.floor(fontSize * 0.56));
  const pillHeight = Math.max(28, Math.floor(fontSize * 1.55));

  ctx.save();
  ctx.font = `900 ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const target of targets) {
    const style = target.style ?? TARGET_FORMANT_PATH_STYLE;

    if (isFormantPathTarget(target)) {
      const targetPath = formantTargetPathFromTarget(target);

      if (targetPath) {
        paintFormantTargetPath(
          ctx,
          width,
          height,
          range,
          targetPath,
          fontSize,
          paddingX,
          pillHeight,
          style,
          occupiedLabels,
        );
      }
      continue;
    }

    const x = formantX(target.f2, range, area);
    const y = formantY(target.f1, range, area);
    const labelWidth = ctx.measureText(target.label).width;
    const pillWidth = Math.max(pillHeight, labelWidth + paddingX * 2);
    const left = Math.max(area.left, Math.min(area.right - pillWidth, x - pillWidth / 2));
    const top = Math.max(area.top, Math.min(area.bottom - pillHeight, y - pillHeight / 2));

    ctx.fillStyle = style.targetLabelFill ?? style.pointFill;
    ctx.strokeStyle = style.targetLabelStroke ?? style.pointOutline;
    ctx.lineWidth = Math.max(2, Math.floor(scale / 420));
    roundedRectPath(ctx, left, top, pillWidth, pillHeight, pillHeight / 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = style.targetLabelText ?? style.mainLabelText ?? "#202020";
    ctx.fillText(target.label, left + pillWidth / 2, top + pillHeight / 2 + 0.5);
  }

  ctx.restore();
}

function paintFormantTargetPaths(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  range: FormantChartRange,
  paths: readonly FormantTargetPath[],
  occupiedLabels: FormantLabelBox[],
): void {
  const scale = formantScale(width, height);
  const fontSize = Math.max(18, Math.min(38, Math.floor(scale / 18)));
  const paddingX = Math.max(8, Math.floor(fontSize * 0.56));
  const pillHeight = Math.max(28, Math.floor(fontSize * 1.55));

  ctx.save();
  ctx.font = `900 ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const path of paths) {
    paintFormantTargetPath(
      ctx,
      width,
      height,
      range,
      path,
      fontSize,
      paddingX,
      pillHeight,
      path.style ?? WORD_FORMANT_PATH_STYLE,
      occupiedLabels,
    );
  }

  ctx.restore();
}

function isFormantPathTarget(target: FormantTarget): target is FormantTarget & { endF1: number; endF2: number } {
  return Number.isFinite(target.endF1) && Number.isFinite(target.endF2);
}

function formantTargetPathFromTarget(target: FormantTarget): FormantTargetPath | undefined {
  if (!isFormantPathTarget(target)) {
    return undefined;
  }

  const [startLabel, endLabel] = diphthongComponentLabels(target.label);

  return {
    id: target.id,
    label: target.label,
    points: [
      { label: startLabel, f1: target.f1, f2: target.f2 },
      { label: endLabel, f1: target.endF1, f2: target.endF2 },
    ],
  };
}

function diphthongComponentLabels(label: string): readonly [string, string] {
  const normalized = normalizePhonemeIpa(label);
  const components: Record<string, readonly [string, string]> = {
    "eɪ": ["/e/", "/ɪ/"],
    "əʊ": ["/ə/", "/ʊ/"],
    "aɪ": ["/a/", "/ɪ/"],
    "ɔɪ": ["/ɔ/", "/ɪ/"],
    "aʊ": ["/a/", "/ʊ/"],
    "ɪə": ["/ɪ/", "/ə/"],
    "eə": ["/e/", "/ə/"],
    "ʊə": ["/ʊ/", "/ə/"],
  };

  return components[normalized] ?? ["start", "finish"];
}

function paintFormantTargetPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  range: FormantChartRange,
  path: FormantTargetPath,
  fontSize: number,
  paddingX: number,
  pillHeight: number,
  style: FormantPathStyle,
  occupiedLabels: FormantLabelBox[],
): void {
  const area = formantPlotArea(width, height);
  const scale = formantScale(width, height);
  const points = path.points.map((point) => ({
    ...point,
    x: formantX(point.f2, range, area),
    y: formantY(point.f1, range, area),
  }));

  if (points.length === 0) {
    return;
  }

  const lineWidth = Math.max(3, Math.min(10, Math.floor(scale / 100)));
  const startRadius = Math.max(6, Math.min(17, Math.floor(scale / 58)));
  const labelWidth = ctx.measureText(path.label).width;
  const pillWidth = Math.max(pillHeight, labelWidth + paddingX * 2);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const strokeTargetPath = (strokeStyle: string, strokeWidth: number) => {
    if (points.length < 2) {
      return;
    }

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = strokeWidth;
    ctx.beginPath();

    points.forEach((point, index) => {
      if (index === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });

    ctx.stroke();
  };

  strokeTargetPath(style.outerStroke, lineWidth + Math.max(5, Math.floor(scale / 90)));
  strokeTargetPath(style.middleStroke, lineWidth + Math.max(2, Math.floor(scale / 160)));
  strokeTargetPath(style.innerStroke, lineWidth);

  if (points.length > 1) {
    const arrowSize = Math.max(11, Math.min(24, Math.floor(scale / 34)));

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];

      if (!previous || !current) {
        continue;
      }

      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      const length = Math.hypot(dx, dy);

      if (length <= 8) {
        continue;
      }

      paintFormantArrowHead(
        ctx,
        previous.x + dx * 0.52,
        previous.y + dy * 0.52,
        Math.atan2(dy, dx),
        arrowSize,
        style,
      );
    }
  }

  points.forEach((point, index) => {
    ctx.fillStyle = index === points.length - 1 ? style.pointFill : "#fffdfa";
    ctx.strokeStyle = style.pointOutline;
    ctx.lineWidth = Math.max(2, Math.floor(scale / 420));
    ctx.beginPath();
    ctx.arc(point.x, point.y, startRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = style.pointOutline;
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(2, startRadius * 0.35), 0, Math.PI * 2);
    ctx.fill();
    paintFormantPointLabel(ctx, point.label, point.x, point.y, area, scale, index, style, occupiedLabels);
  });

  const labelAnchor = formantPathLabelAnchor(points, area, pillWidth, pillHeight, scale, style.labelPreference);
  const labelBox = placeFormantLabelBox(labelAnchor, pillWidth, pillHeight, area, scale, occupiedLabels, style.labelPreference);
  const pillLeft = labelBox.left;
  const pillTop = labelBox.top;

  ctx.fillStyle = style.mainLabelFill ?? style.middleStroke;
  ctx.strokeStyle = style.mainLabelStroke ?? style.innerStroke;
  ctx.lineWidth = Math.max(2, Math.floor(scale / 420));
  roundedRectPath(ctx, pillLeft, pillTop, pillWidth, pillHeight, pillHeight / 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = style.mainLabelText ?? "#202020";
  ctx.font = `900 ${fontSize}px sans-serif`;
  ctx.fillText(path.label, pillLeft + pillWidth / 2, pillTop + pillHeight / 2 + 0.5);
  occupiedLabels.push(labelBox);
  ctx.restore();
}

function formantPathLabelAnchor(
  points: readonly (FormantTargetPathPoint & { x: number; y: number })[],
  area: { top: number; right: number; bottom: number; left: number },
  labelWidth: number,
  labelHeight: number,
  scale: number,
  labelPreference: FormantPathStyle["labelPreference"] = "above",
): { x: number; y: number } {
  const fallback = points[0] ?? { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 };
  const offset = Math.max(44, Math.min(92, Math.floor(scale / 3.8)));
  const preferredDirection = labelPreference === "below" ? 1 : -1;
  let anchor = { x: fallback.x, y: fallback.y + offset * preferredDirection };

  if (points.length > 1) {
    const middleIndex = Math.floor((points.length - 1) / 2);
    const from = points[middleIndex] ?? fallback;
    const to = points[middleIndex + 1] ?? points[middleIndex] ?? fallback;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const mid = { x: from.x + dx * 0.5, y: from.y + dy * 0.5 };
    let normal = { x: -dy / length, y: dx / length };

    if (normal.y * preferredDirection < 0) {
      normal = { x: -normal.x, y: -normal.y };
    }

    anchor = {
      x: mid.x + normal.x * offset,
      y: mid.y + normal.y * offset,
    };
  }

  return {
    x: Math.max(area.left + labelWidth / 2, Math.min(area.right - labelWidth / 2, anchor.x)),
    y: Math.max(area.top + labelHeight / 2, Math.min(area.bottom - labelHeight / 2, anchor.y)),
  };
}

function paintFormantPointLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  area: { top: number; right: number; bottom: number; left: number },
  scale: number,
  index: number,
  style: FormantPathStyle,
  occupiedLabels: FormantLabelBox[],
): void {
  const fontSize = Math.max(12, Math.min(24, Math.floor(scale / 24)));
  const paddingX = Math.max(5, Math.floor(fontSize * 0.42));
  const labelHeight = Math.max(18, Math.floor(fontSize * 1.45));
  const offsetY = index % 2 === 0 ? -Math.max(22, Math.floor(scale / 18)) : Math.max(22, Math.floor(scale / 18));

  ctx.save();
  ctx.font = `850 ${fontSize}px sans-serif`;
  const labelWidth = Math.max(labelHeight, ctx.measureText(label).width + paddingX * 2);
  const labelPreference = offsetY > 0 ? "below" : "above";
  const labelBox = placeFormantLabelBox(
    { x, y: y + offsetY },
    labelWidth,
    labelHeight,
    area,
    scale,
    occupiedLabels,
    labelPreference,
  );
  const left = labelBox.left;
  const top = labelBox.top;

  ctx.fillStyle = style.componentLabelFill ?? "rgba(255, 253, 250, 0.9)";
  ctx.strokeStyle = style.componentLabelStroke ?? style.innerStroke;
  ctx.lineWidth = Math.max(1, Math.floor(scale / 700));
  roundedRectPath(ctx, left, top, labelWidth, labelHeight, labelHeight / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = style.componentLabelText ?? style.innerStroke;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + labelWidth / 2, top + labelHeight / 2 + 0.5);
  occupiedLabels.push(labelBox);
  ctx.restore();
}

function placeFormantLabelBox(
  preferredCenter: { x: number; y: number },
  width: number,
  height: number,
  area: { top: number; right: number; bottom: number; left: number },
  scale: number,
  occupiedLabels: readonly FormantLabelBox[],
  labelPreference: FormantPathStyle["labelPreference"] = "above",
): FormantLabelBox {
  const gap = Math.max(4, Math.floor(scale / 150));
  const stepX = Math.max(10, Math.floor(width * 0.38));
  const stepY = Math.max(10, Math.floor(height * 0.82));
  const preferredDirection = labelPreference === "below" ? 1 : -1;
  const verticalSteps = [0, 1, -1, 2, -2, 3, -3, 4, -4];
  const horizontalSteps = [0, -1, 1, -2, 2, -3, 3, -4, 4];
  let bestBox = formantLabelBoxForCenter(preferredCenter.x, preferredCenter.y, width, height, area);
  let bestWeightedScore = formantLabelOverlapScore(bestBox, occupiedLabels, gap);

  for (const verticalStep of verticalSteps) {
    for (const horizontalStep of horizontalSteps) {
      if (Math.abs(verticalStep) + Math.abs(horizontalStep) > 6) {
        continue;
      }

      const candidate = formantLabelBoxForCenter(
        preferredCenter.x + horizontalStep * stepX,
        preferredCenter.y + verticalStep * preferredDirection * stepY,
        width,
        height,
        area,
      );
      const score = formantLabelOverlapScore(candidate, occupiedLabels, gap);

      if (score === 0) {
        return candidate;
      }

      const distancePenalty = Math.abs(horizontalStep) * width + Math.abs(verticalStep) * height;
      const weightedScore = score + distancePenalty * 0.001;

      if (weightedScore < bestWeightedScore) {
        bestBox = candidate;
        bestWeightedScore = weightedScore;
      }
    }
  }

  return bestBox;
}

function formantLabelBoxForCenter(
  x: number,
  y: number,
  width: number,
  height: number,
  area: { top: number; right: number; bottom: number; left: number },
): FormantLabelBox {
  const left = Math.max(area.left, Math.min(area.right - width, x - width / 2));
  const top = Math.max(area.top, Math.min(area.bottom - height, y - height / 2));

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}

function formantLabelOverlapScore(box: FormantLabelBox, occupiedLabels: readonly FormantLabelBox[], gap: number): number {
  let score = 0;

  for (const occupied of occupiedLabels) {
    const overlapWidth = Math.max(0, Math.min(box.right + gap, occupied.right) - Math.max(box.left - gap, occupied.left));
    const overlapHeight = Math.max(0, Math.min(box.bottom + gap, occupied.bottom) - Math.max(box.top - gap, occupied.top));

    score += overlapWidth * overlapHeight;
  }

  return score;
}

function paintFormantArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
  style: FormantPathStyle,
): void {
  const tip = {
    x: x + Math.cos(angle) * size * 0.55,
    y: y + Math.sin(angle) * size * 0.55,
  };
  const base = {
    x: x - Math.cos(angle) * size * 0.45,
    y: y - Math.sin(angle) * size * 0.45,
  };
  const perpendicular = {
    x: -Math.sin(angle) * size * 0.46,
    y: Math.cos(angle) * size * 0.46,
  };

  ctx.save();
  ctx.fillStyle = style.innerStroke;
  ctx.strokeStyle = "#fffdfa";
  ctx.lineWidth = Math.max(2, Math.floor(size / 7));
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(base.x + perpendicular.x, base.y + perpendicular.y);
  ctx.lineTo(base.x - perpendicular.x, base.y - perpendicular.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const clampedRadius = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + clampedRadius, y);
  ctx.lineTo(x + width - clampedRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + clampedRadius);
  ctx.lineTo(x + width, y + height - clampedRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - clampedRadius, y + height);
  ctx.lineTo(x + clampedRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - clampedRadius);
  ctx.lineTo(x, y + clampedRadius);
  ctx.quadraticCurveTo(x, y, x + clampedRadius, y);
  ctx.closePath();
}

function paintFormantPath(
  ctx: CanvasRenderingContext2D,
  formants: NonNullable<PrecomputedSpectrogram["formants"]>,
  progress: number,
  width: number,
  height: number,
  range = formantChartRange(formants),
  style = RECORDED_FORMANT_PATH_STYLE,
): void {
  const maxTime = Math.max(0.001, formants.duration * progress);
  const area = formantPlotArea(width, height);
  const scale = formantScale(width, height);
  const lineWidth = Math.max(2, Math.min(9, Math.floor(scale / 130)));

  const strokePath = (strokeStyle: string, strokeWidth: number): { x: number; y: number } | null => {
    let pathStarted = false;
    let lastPoint: { x: number; y: number } | null = null;
    let previousTime: number | null = null;

    ctx.beginPath();

    for (const point of formants.points) {
      if (point.time > maxTime) {
        break;
      }

      if (point.f1 === null || point.f2 === null) {
        pathStarted = false;
        previousTime = null;
        continue;
      }

      const x = formantX(point.f2, range, area);
      const y = formantY(point.f1, range, area);

      if (!pathStarted || (previousTime !== null && point.time - previousTime > 0.045)) {
        ctx.moveTo(x, y);
        pathStarted = true;
      } else {
        ctx.lineTo(x, y);
      }

      previousTime = point.time;
      lastPoint = { x, y };
    }

    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    return lastPoint;
  };

  ctx.save();
  strokePath(style.outerStroke, lineWidth + Math.max(2, Math.floor(scale / 520)));
  strokePath(style.middleStroke, lineWidth + Math.max(1, Math.floor(scale / 700)));
  const lastPoint = strokePath(style.innerStroke, lineWidth);

  if (lastPoint) {
    ctx.fillStyle = style.pointFill;
    ctx.strokeStyle = style.pointStroke;
    ctx.lineWidth = Math.max(2, Math.floor(scale / 460));
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, Math.max(5, Math.min(26, Math.floor(scale / 38))), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = style.pointOutline;
    ctx.lineWidth = Math.max(1, Math.floor(scale / 720));
    ctx.stroke();
  }

  ctx.restore();
}

function formantScale(width: number, height: number): number {
  return Math.min(width, height);
}

function formantPlotArea(width: number, height: number): { top: number; right: number; bottom: number; left: number } {
  return {
    top: Math.max(24, Math.floor(height * 0.09)),
    right: width - Math.max(18, Math.floor(width * 0.08)),
    bottom: height - Math.max(48, Math.floor(height * 0.16)),
    left: Math.max(56, Math.floor(width * 0.17)),
  };
}

function formantX(f2: number, range: FormantChartRange, area: { right: number; left: number }): number {
  const normalized = (range.maxF2 - f2) / Math.max(1, range.maxF2 - range.minF2);

  return area.left + Math.max(0, Math.min(1, normalized)) * (area.right - area.left);
}

function formantY(f1: number, range: FormantChartRange, area: { top: number; bottom: number }): number {
  const normalized = (f1 - range.minF1) / Math.max(1, range.maxF1 - range.minF1);

  return area.top + Math.max(0, Math.min(1, normalized)) * (area.bottom - area.top);
}

function getRenderedSpectrogram(spectrogram: PrecomputedSpectrogram): HTMLCanvasElement {
  const cached = renderedSpectrograms.get(spectrogram);

  if (cached) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = spectrogram.columnCount;
  canvas.height = spectrogram.binCount;

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create spectrogram image context.");
  }

  const image = ctx.createImageData(canvas.width, canvas.height);

  for (let x = 0; x < canvas.width; x += 1) {
    for (let y = 0; y < canvas.height; y += 1) {
      const normalizedY = 1 - y / Math.max(1, canvas.height - 1);
      const bin = Math.min(spectrogram.binCount - 1, Math.floor(normalizedY ** 2.4 * (spectrogram.binCount - 1)));
      const value = (spectrogram.data[x * spectrogram.binCount + bin] ?? 0) / 255;
      const [red, green, blue] = spectrogramRgb(value);
      const pixelIndex = (y * canvas.width + x) * 4;

      image.data[pixelIndex] = red;
      image.data[pixelIndex + 1] = green;
      image.data[pixelIndex + 2] = blue;
      image.data[pixelIndex + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  renderedSpectrograms.set(spectrogram, canvas);

  return canvas;
}

function getSpectrogramProgress(visualization: PlaybackVisualizationState, startedAt: number): number {
  const timing = visualization.getTiming?.();

  if (timing?.duration) {
    return timing.currentTime / timing.duration;
  }

  return Math.min(0.98, (performance.now() - startedAt) / 1600);
}

function prepareSpectrogramCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  resized: boolean;
} {
  const rect = canvas.getBoundingClientRect();
  const expanded = Boolean(canvas.closest(".spectrogram-panel.expanded"));
  const deviceRatio = window.devicePixelRatio || 1;
  const ratio = Math.min(deviceRatio * (expanded ? 2.5 : 1.75), expanded ? 4 : 3);
  const cssWidth = Math.max(280, Math.floor(rect.width || 420));
  const cssHeight = Math.max(120, Math.floor(rect.height || 150));
  const width = Math.floor(cssWidth * ratio);
  const height = Math.floor(cssHeight * ratio);

  const resized = canvas.width !== width || canvas.height !== height;

  if (resized) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create spectrogram canvas context.");
  }

  return { ctx, width, height, resized };
}

function prepareFormantCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  resized: boolean;
} {
  const rect = canvas.getBoundingClientRect();
  const expanded = Boolean(canvas.closest(".spectrogram-panel.expanded"));
  const deviceRatio = window.devicePixelRatio || 1;
  const ratio = Math.min(deviceRatio * (expanded ? 2.25 : 1.75), expanded ? 4 : 3);
  const cssWidth = Math.max(280, Math.floor(rect.width || 420));
  const cssHeight = Math.max(280, Math.floor(rect.height || cssWidth));
  const width = Math.floor(cssWidth * ratio);
  const height = Math.floor(cssHeight * ratio);
  const resized = canvas.width !== width || canvas.height !== height;

  if (resized) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("Could not create formant canvas context.");
  }

  return { ctx, width, height, resized };
}

function paintSpectrogramGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(32, 32, 32, 0.12)";
  ctx.lineWidth = Math.max(1, Math.floor(width / 420));

  for (let index = 1; index < 4; index += 1) {
    const y = Math.floor((height / 4) * index) + 0.5;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  for (let index = 1; index < 6; index += 1) {
    const x = Math.floor((width / 6) * index) + 0.5;

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  ctx.restore();
}

function paintIdlePattern(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(138, 104, 20, 0.55)";
  ctx.lineWidth = Math.max(2, Math.floor(width / 260));
  ctx.beginPath();

  for (let x = 0; x <= width; x += 6) {
    const y = height * 0.55 + Math.sin(x / 24) * height * 0.08;

    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function paintVoicePattern(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();

  for (let x = 0; x < width; x += Math.max(8, Math.floor(width / 36))) {
    const strength = 0.25 + 0.45 * Math.abs(Math.sin(x / 31));
    const barHeight = height * strength;

    ctx.fillStyle = spectrogramColor(strength * 0.75);
    ctx.fillRect(x, height - barHeight, Math.max(3, Math.floor(width / 120)), barHeight);
  }

  ctx.restore();
}

function paintUnavailablePattern(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = "rgba(47, 94, 158, 0.4)";
  ctx.lineWidth = Math.max(2, Math.floor(width / 220));

  for (let x = -height; x < width; x += Math.max(18, Math.floor(width / 24))) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
    ctx.stroke();
  }

  ctx.restore();
}

function spectrogramColor(value: number): string {
  const [red, green, blue] = spectrogramRgb(value);

  return `rgb(${red}, ${green}, ${blue})`;
}

function spectrogramRgb(value: number): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, value));

  if (clamped < 0.35) {
    return mixRgb([244, 241, 234], [214, 206, 194], clamped / 0.35);
  }

  if (clamped < 0.72) {
    return mixRgb([214, 206, 194], [138, 104, 20], (clamped - 0.35) / 0.37);
  }

  return mixRgb([138, 104, 20], [38, 79, 135], (clamped - 0.72) / 0.28);
}

function mixColor(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  amount: number,
): string {
  const [red, green, blue] = mixRgb(start, end, amount);

  return `rgb(${red}, ${green}, ${blue})`;
}

function mixRgb(
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  const clamped = Math.max(0, Math.min(1, amount));
  const [red, green, blue] = start.map((channel, index) =>
    Math.round(channel + ((end[index] ?? channel) - channel) * clamped)
  ) as [number, number, number];

  return [red, green, blue];
}

function AudioCreditsPanel(props: { credits: readonly AudioCredit[]; ttsEnabled: boolean }) {
  return (
    <details class="audio-credits">
      <summary>Audio credits</summary>
      <Show
        when={props.credits.length > 0}
        fallback={<p class="muted">{props.ttsEnabled
          ? "No recordings are used in the current view. The app may use your browser voice instead."
          : "No recordings are used in the current view."}</p>}
      >
        <div class="audio-credit-list">
          <For each={props.credits}>
            {(credit) => (
              <article class="audio-credit-card">
                <strong>{credit.labels.join(", ")}</strong>
                <p>
                  {credit.source.license ?? "License unknown"}
                  <Show when={credit.source.accent}>
                    {(accent) => <> · {accent()}</>}
                  </Show>
                </p>
                <Show when={credit.source.attribution}>
                  {(attribution) => <p>{attribution()}</p>}
                </Show>
                <p>
                  <Show
                    when={credit.source.sourceUrl}
                    fallback={<span class="muted">Source: {credit.source.src}</span>}
                  >
                    {(sourceUrl) => (
                      <a href={sourceUrl()} target="_blank" rel="noreferrer">
                        Source file
                      </a>
                    )}
                  </Show>
                </p>
              </article>
            )}
          </For>
        </div>
      </Show>
    </details>
  );
}

function EmptyDataset() {
  return (
    <section class="training-panel">
      <h2>No recorded practice content yet</h2>
      <p>Add recordings or choose another sound to start a session.</p>
    </section>
  );
}

function getAssignedTermForSlot(
  prompt: MatchingPrompt,
  selections: PromptSelections,
  slot: PromptSlot,
): MinimalPairTerm | undefined {
  const termId = selections[slot.id];

  return termId ? prompt.item.terms.find((term) => term.id === termId) : undefined;
}

function getAssignedSlotForTerm(
  prompt: MatchingPrompt,
  selections: PromptSelections,
  term: MinimalPairTerm,
): PromptSlot | undefined {
  return prompt.slots.find((slot) => selections[slot.id] === term.id);
}

function soundButtonClass(
  slot: PromptSlot,
  prompt: MatchingPrompt,
  selections: PromptSelections,
  result: PromptResult | null,
  selectedSlotId: string | null,
): string {
  const classes = ["sound-button"];
  const selected = selectedSlotId === slot.id;
  const matched = Boolean(selections[slot.id]);
  const answer = result?.answers.find((candidate) => candidate.slotId === slot.id);

  if (selected) {
    classes.push("selected");
  }

  if (matched) {
    classes.push("matched");
  }

  if (selected || matched || answer) {
    classes.push(slotPairClass(prompt, slot.id));
  }

  if (answer) {
    classes.push(answer.correct ? "correct" : "incorrect");
  }

  return classes.join(" ");
}

function wordButtonClass(
  term: MinimalPairTerm,
  prompt: MatchingPrompt,
  selections: PromptSelections,
  result: PromptResult | null,
  selectedSlotId: string | null,
): string {
  const classes = ["word-button"];
  const assignedSlot = getAssignedSlotForTerm(prompt, selections, term);
  const answer = assignedSlot
    ? result?.answers.find((candidate) => candidate.slotId === assignedSlot.id)
    : undefined;

  if (selectedSlotId) {
    classes.push("ready");
  }

  if (assignedSlot) {
    classes.push("matched");
    classes.push(slotPairClass(prompt, assignedSlot.id));
  }

  if (answer) {
    classes.push(answer.correct ? "correct" : "incorrect");
  }

  return classes.join(" ");
}

function sortGroupClass(
  prompt: SortingPrompt,
  group: SortingGroup,
  selectedTermId: string | null,
  result: PromptResult | null,
): string {
  const classes = ["sort-group", groupPairClass(prompt, group.phonemeId)];

  if (selectedTermId && !result) {
    classes.push("ready");
  }

  return classes.join(" ");
}

function sortWordCardClass(
  term: MinimalPairTerm,
  prompt: SortingPrompt,
  placements: SortingPlacements,
  result: PromptResult | null,
  selectedTermId: string | null,
): string {
  const classes = ["sort-word-card"];
  const placement = placements[term.id];
  const answer = result?.answers.find((candidate) => candidate.heardTermId === term.id);

  if (placement) {
    classes.push("placed", groupPairClass(prompt, placement));
  }

  if (selectedTermId === term.id) {
    classes.push("selected");
  }

  if (answer) {
    classes.push(answer.correct ? "correct" : "incorrect");
  }

  return classes.join(" ");
}

function sortingWordCardLabel(prompt: SortingPrompt, term: MinimalPairTerm, hideWordName: boolean): string {
  return hideWordName ? sortingSampleLabel(prompt, term) : term.word.written;
}

function sortingSampleLabel(prompt: SortingPrompt | undefined, term: MinimalPairTerm): string {
  const index = prompt?.wordCards.findIndex((candidate) => candidate.id === term.id) ?? -1;

  return `Sample ${alphabeticSampleLabel(index >= 0 ? index : 0)}`;
}

function alphabeticSampleLabel(index: number): string {
  let current = index;
  let label = "";

  do {
    label = String.fromCharCode("A".charCodeAt(0) + (current % 26)) + label;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return label;
}

function slotPairClass(prompt: MatchingPrompt, slotId: string): string {
  const index = prompt.slots.findIndex((slot) => slot.id === slotId);

  return pairClass(index);
}

function groupPairClass(prompt: SortingPrompt, phonemeId: PhonemeId): string {
  const index = prompt.groups.findIndex((group) => group.phonemeId === phonemeId);

  return pairClass(index);
}

function pairClass(index: number): string {
  return `pair-${index >= 0 ? (index % 6) + 1 : 1}`;
}

function phonemeLabel(phonemeId: PhonemeId): string {
  return phonemeLabelForDataset(phonemeId, dataset);
}

function phonemeLabelForDataset(phonemeId: PhonemeId, sourceDataset: LanguageDataset): string {
  return sourceDataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.ipa ?? phonemeId;
}

function phonemePairLabel(phonemePair: PhonemePair): string {
  return phonemeIdsLabel(phonemePair);
}

function phonemeIdsLabel(phonemeIds: readonly PhonemeId[]): string {
  return phonemeIds.map(phonemeLabel).join(" vs ");
}

function phonemeCardClass(
  phoneme: Phoneme,
  draftPhonemeIds: readonly PhonemeId[],
  activePhonemePair: PhonemePair | null,
  unrecorded = false,
): string {
  const classes = ["phoneme-card"];

  if (unrecorded) {
    classes.push("unrecorded");
  }

  if (draftPhonemeIds.includes(phoneme.id)) {
    classes.push("selected");
  }

  if (activePhonemePair?.includes(phoneme.id)) {
    classes.push("active");
  }

  return classes.join(" ");
}

function contrastCardClass(
  contrast: PhonemeContrast,
  activePhonemePair: PhonemePair | null,
): string {
  const classes = ["contrast-card", "contrast-button"];

  if (activePhonemePair && samePhonemePair(contrast.phonemeIds, activePhonemePair)) {
    classes.push("active");
  }

  return classes.join(" ");
}

function wordsForPhoneme(phonemeId: PhonemeId, sourceDataset = dataset): WordEntry[] {
  return sourceDataset.words.filter((word) => word.phonemeIds.includes(phonemeId));
}

function samplePhonemeCardWords(phonemeId: PhonemeId, sourceDataset: LanguageDataset): WordEntry[] {
  const words = wordsForPhoneme(phonemeId, sourceDataset);
  const recordedWords = words.filter(hasWordRecording);

  return sampleRandomWords(recordedWords.length > 0 ? recordedWords : words, PHONEME_CARD_EXAMPLE_WORD_COUNT);
}

function sampleRandomWords(words: readonly WordEntry[], limit: number): WordEntry[] {
  const remaining = [...words];
  const sample: WordEntry[] = [];

  while (sample.length < limit && remaining.length > 0) {
    const index = Math.floor(Math.random() * remaining.length);
    const [word] = remaining.splice(index, 1);

    if (word) {
      sample.push(word);
    }
  }

  return sample;
}

function phonemeHasWordRecording(phonemeId: PhonemeId, sourceDataset = dataset): boolean {
  return wordsForPhoneme(phonemeId, sourceDataset).some(hasWordRecording);
}

function fillContributionSessionQueue(
  currentItems: readonly ContributionQueueItem[],
  candidateWordIds: ReadonlySet<string>,
  keptWordIds: ReadonlySet<string>,
  skippedWordIds: ReadonlySet<string>,
  sourceDataset: LanguageDataset,
): ContributionQueueItem[] {
  const retainedItems = currentItems
    .filter((item) =>
      candidateWordIds.has(item.word.id)
      && !keptWordIds.has(item.word.id)
      && !skippedWordIds.has(item.word.id)
    )
    .slice(0, CONTRIBUTION_SESSION_QUEUE_SIZE);
  const retainedWordIds = new Set(retainedItems.map((item) => item.word.id));
  const excludedWordIds = new Set([...keptWordIds, ...skippedWordIds, ...retainedWordIds]);
  const assumedRecordedWordIds = new Set([...keptWordIds, ...retainedWordIds]);
  const additions = createContributionQueue(sourceDataset, excludedWordIds, {
    assumedRecordedWordIds,
    candidateWordIds,
    limit: Math.max(0, CONTRIBUTION_SESSION_QUEUE_SIZE - retainedItems.length),
  });

  return [...retainedItems, ...additions];
}

function phonemeHasAudio(phonemeId: PhonemeId): boolean {
  return Boolean(dataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.audio?.length);
}

function minimalPairCount(sourceDataset = dataset): number {
  return sourceDataset.contrasts.reduce((total, contrast) => total + contrast.minimalPairs.length, 0);
}

function collectTermAudioCredits(terms: readonly MinimalPairTerm[]): AudioCredit[] {
  const credits = new Map<string, AudioCredit>();

  for (const term of terms) {
    const source = term.selectedAudio ?? term.word.audio[0];

    if (source) {
      addAudioCredit(credits, `${term.word.written} ${term.word.ipa}`, source);
    }
  }

  return sortAudioCredits(credits);
}

function collectWordAudioCredits(words: readonly WordEntry[]): AudioCredit[] {
  const credits = new Map<string, AudioCredit>();

  for (const word of words) {
    for (const source of word.audio) {
      addAudioCredit(credits, `${word.written} ${word.ipa}`, source);
    }
  }

  return sortAudioCredits(credits);
}

function sortAudioCredits(credits: Map<string, AudioCredit>): AudioCredit[] {
  return [...credits.values()].sort((left, right) =>
    (left.labels[0] ?? "").localeCompare(right.labels[0] ?? "")
  );
}

function addAudioCredit(credits: Map<string, AudioCredit>, label: string, source: AudioSource): void {
  if (!source.src || source.kind === "tts") {
    return;
  }

  const key = source.sourceUrl ?? source.src;
  const existing = credits.get(key);

  if (existing) {
    if (!existing.labels.includes(label)) {
      existing.labels.push(label);
    }

    return;
  }

  credits.set(key, { key, labels: [label], source });
}

function loadSpeechVoiceURI(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  return localStorage.getItem(SPEECH_VOICE_STORAGE_KEY);
}

function loadLastLanguageId(): string | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  return parseLanguageId(localStorage.getItem(LAST_LANGUAGE_STORAGE_KEY));
}

function saveLastLanguageId(languageId: string): void {
  const parsedLanguageId = parseLanguageId(languageId);

  if (!parsedLanguageId || typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(LAST_LANGUAGE_STORAGE_KEY, parsedLanguageId);
}

function saveSpeechVoiceURI(voiceURI: string | null): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  if (voiceURI) {
    localStorage.setItem(SPEECH_VOICE_STORAGE_KEY, voiceURI);
    return;
  }

  localStorage.removeItem(SPEECH_VOICE_STORAGE_KEY);
}

function createDefaultContributionDetails(): ContributionDetails {
  return {
    schemaVersion: 1,
    licence: "CC0-1.0",
    speakerName: "",
    accent: "",
  };
}

function loadContributionDetails(): ContributionDetails {
  if (typeof localStorage === "undefined") {
    return createDefaultContributionDetails();
  }

  const raw = localStorage.getItem(CONTRIBUTION_DETAILS_STORAGE_KEY);

  if (!raw) {
    return createDefaultContributionDetails();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ContributionDetails>;

    if (parsed.schemaVersion !== 1) {
      return createDefaultContributionDetails();
    }

    return {
      schemaVersion: 1,
      licence: isContributionLicence(parsed.licence) ? parsed.licence : "CC0-1.0",
      speakerName: typeof parsed.speakerName === "string" ? parsed.speakerName : "",
      accent: typeof parsed.accent === "string" ? parsed.accent : "",
    };
  } catch {
    return createDefaultContributionDetails();
  }
}

function saveContributionDetails(details: ContributionDetails): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(CONTRIBUTION_DETAILS_STORAGE_KEY, JSON.stringify(details));
}

function createDefaultContributionHistory(): ContributionHistory {
  return {
    schemaVersion: 1,
    downloadedWordIds: [],
  };
}

function loadDownloadedContributionWordIds(): string[] {
  if (typeof localStorage === "undefined") {
    return createDefaultContributionHistory().downloadedWordIds;
  }

  const raw = localStorage.getItem(CONTRIBUTION_HISTORY_STORAGE_KEY);

  if (!raw) {
    return createDefaultContributionHistory().downloadedWordIds;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ContributionHistory>;

    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.downloadedWordIds)) {
      return createDefaultContributionHistory().downloadedWordIds;
    }

    return [...new Set(parsed.downloadedWordIds.filter((wordId): wordId is string => typeof wordId === "string" && wordId.length > 0))];
  } catch {
    return createDefaultContributionHistory().downloadedWordIds;
  }
}

function saveDownloadedContributionWordIds(downloadedWordIds: readonly string[]): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  localStorage.setItem(CONTRIBUTION_HISTORY_STORAGE_KEY, JSON.stringify({
    schemaVersion: 1,
    downloadedWordIds: [...downloadedWordIds],
  } satisfies ContributionHistory));
}

function mergeDownloadedContributionWordIds(current: readonly string[], additions: readonly string[]): string[] {
  const next = [...current];
  const seen = new Set(next);

  for (const wordId of additions) {
    if (!wordId || seen.has(wordId)) {
      continue;
    }

    seen.add(wordId);
    next.push(wordId);
  }

  return next;
}

function isContributionLicence(value: unknown): value is ContributionLicence {
  return value === "CC0-1.0" || value === "CC-BY-4.0";
}

function createPracticeDataset(sourceDataset: LanguageDataset, ttsEnabled: boolean): LanguageDataset {
  if (ttsEnabled) {
    return sourceDataset;
  }

  const words = sourceDataset.words.filter(hasWordRecording);
  const wordIds = new Set(words.map((word) => word.id));
  const contrasts = sourceDataset.contrasts
    .map((contrast) => ({
      ...contrast,
      minimalPairs: contrast.minimalPairs.filter((pair) =>
        pair.terms.every((term) => wordIds.has(term.wordId))
      ),
    }))
    .filter((contrast) => contrast.minimalPairs.length > 0);

  return {
    ...sourceDataset,
    words,
    contrasts,
  };
}

function hasWordRecording(word: WordEntry): boolean {
  return word.audio.length > 0;
}

function selectedAudioForTerm(term: MinimalPairTerm): AudioSource | undefined {
  return term.selectedAudio ?? term.word.audio[0];
}

function chooseRandomAudioSource(sources: readonly AudioSource[]): AudioSource | undefined {
  if (sources.length === 0) {
    return undefined;
  }

  return sources[Math.floor(Math.random() * sources.length)] ?? sources[0];
}

function chooseRandomWordWithRecording(words: readonly WordEntry[]): WordEntry | undefined {
  const recordedWords = words.filter((word) => word.audio.length > 0);

  if (recordedWords.length === 0) {
    return undefined;
  }

  return recordedWords[Math.floor(Math.random() * recordedWords.length)] ?? recordedWords[0];
}

function stopStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function audioPlaybackProgress(audio: HTMLAudioElement): number {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : CONTRIBUTION_RECORDING_DURATION_MS / 1000;

  if (duration <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(1, audio.currentTime / duration));
}

function loadRecordingPreviewAudio(audio: HTMLAudioElement): void {
  debugContributionAudio("preview audio mounted", audioDebugSnapshot(audio));

  const load = () => {
    if (audio.isConnected) {
      debugContributionAudio("preview audio load()", audioDebugSnapshot(audio));
      audio.load();
    }
  };

  if (typeof queueMicrotask === "function") {
    queueMicrotask(load);
    return;
  }

  window.setTimeout(load, 0);
}

function createAudioPlaybackProgressTracker(label: string, setProgress: (progress: number) => void) {
  let animationFrame: number | undefined;
  let lastRafProgressBucket = -1;

  const logAudioState = (eventName: string, audio: HTMLAudioElement, progress = audioPlaybackProgress(audio)) => {
    if (eventName === "raf") {
      const progressBucket = Math.floor(progress * 20);

      if (progressBucket === lastRafProgressBucket) {
        return;
      }

      lastRafProgressBucket = progressBucket;
    } else if (eventName === "play" || eventName === "playing" || eventName === "loadedmetadata") {
      lastRafProgressBucket = -1;
    }

    debugContributionAudio(`${label} ${eventName}`, audioDebugSnapshot(audio, progress));
  };

  const stop = () => {
    if (animationFrame === undefined || typeof cancelAnimationFrame === "undefined") {
      animationFrame = undefined;
      return;
    }

    cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
  };

  const update = (audio: HTMLAudioElement, eventName = "update") => {
    const progress = audioPlaybackProgress(audio);

    setProgress(progress);
    logAudioState(eventName, audio, progress);
  };

  const start = (audio: HTMLAudioElement, eventName = "play") => {
    stop();
    logAudioState(eventName, audio);

    const tick = () => {
      update(audio, "raf");

      if (audio.paused || audio.ended || typeof requestAnimationFrame === "undefined") {
        debugContributionAudio(`${label} raf stopped`, audioDebugSnapshot(audio));
        animationFrame = undefined;
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    tick();
  };

  return {
    update,
    start,
    note(audio: HTMLAudioElement, eventName: string) {
      logAudioState(eventName, audio);
    },
    pause(audio: HTMLAudioElement) {
      stop();
      update(audio, "pause");
    },
    end() {
      stop();
      debugContributionAudio(`${label} ended`, { progress: 1 });
      setProgress(1);
    },
    stop,
  };
}

function debugContributionAudio(message: string, details?: Record<string, unknown>): void {
  if (!contributionAudioDebugEnabled()) {
    return;
  }

  console.debug(`[vowel-trowel:audio] ${message}`, details ?? {});
}

function contributionAudioDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const debugAudioParam = new URLSearchParams(window.location.search).get("debugAudio");

    if (debugAudioParam !== null) {
      return !["0", "false", "off"].includes(debugAudioParam.toLowerCase());
    }

    return window.localStorage.getItem(CONTRIBUTION_AUDIO_DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function audioDebugSnapshot(audio: HTMLAudioElement, progress = audioPlaybackProgress(audio)): Record<string, unknown> {
  return {
    progress: Number(progress.toFixed(3)),
    currentTime: Number(audio.currentTime.toFixed(3)),
    duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : String(audio.duration),
    paused: audio.paused,
    ended: audio.ended,
    readyState: audio.readyState,
    networkState: audio.networkState,
    src: describeDebugAudioSource(audio.currentSrc || audio.src),
    error: audio.error ? { code: audio.error.code, message: audio.error.message } : null,
  };
}

function describeDebugAudioSource(src: string): string {
  if (src.startsWith("blob:")) {
    return `blob:${src.slice(-12)}`;
  }

  return src;
}

function chooseRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  return [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  if (mimeType.includes("mp4") || mimeType.includes("mpeg")) {
    return "m4a";
  }

  if (mimeType.includes("wav")) {
    return "wav";
  }

  return "webm";
}

function createContributionManifest(options: {
  language: LanguageDataset;
  word: WordEntry;
  recordingFilename: string;
  mimeType: string;
  recordingSize: number;
  licence: ContributionLicence;
  speakerName: string;
  accent: string;
}) {
  const shortWordId = stripWordPrefix(options.word.id, options.language.id);
  const id = createContributionId(options.language.id, shortWordId);

  return {
    version: 1,
    type: "vowel-trowel-contribution",
    id,
    createdAt: new Date().toISOString(),
    pageUrl: typeof window === "undefined" ? undefined : window.location.href,
    language: createContributionManifestLanguage(options.language),
    word: createContributionManifestWord(options.language, options.word),
    recording: {
      filename: options.recordingFilename,
      mimeType: options.mimeType,
      size: options.recordingSize,
    },
    contribution: {
      licence: options.licence,
      speakerName: options.speakerName || undefined,
      accent: options.accent || undefined,
    },
  };
}

function createContributionBatchManifest(options: {
  language: LanguageDataset;
  id: string;
  recordings: readonly ContributionBatchRecordingForManifest[];
  licence: ContributionLicence;
  speakerName: string;
  accent: string;
}) {
  return {
    version: 2,
    type: "vowel-trowel-contribution",
    id: options.id,
    createdAt: new Date().toISOString(),
    pageUrl: typeof window === "undefined" ? undefined : window.location.href,
    language: createContributionManifestLanguage(options.language),
    contribution: {
      licence: options.licence,
      speakerName: options.speakerName || undefined,
      accent: options.accent || undefined,
    },
    recordings: options.recordings.map((recording) => ({
      id: recording.id,
      filename: recording.filename,
      mimeType: recording.mimeType,
      size: recording.recordingSize,
      recordedAt: recording.recordedAt,
      word: createContributionManifestWord(options.language, recording.word),
    })),
  };
}

function createContributionManifestLanguage(language: LanguageDataset) {
  return {
    id: language.id,
    slug: getLanguageSlug(language.id),
    name: language.name,
    autonym: language.autonym,
  };
}

function createContributionManifestWord(language: LanguageDataset, word: WordEntry) {
  return {
    id: word.id,
    shortId: stripWordPrefix(word.id, language.id),
    written: word.written,
    ipa: word.ipa,
    phonemeIds: word.phonemeIds,
    speechText: word.speechText,
  };
}

function stripWordPrefix(wordId: string, languageId: string): string {
  const prefix = `${getLanguageSlug(languageId)}-word-`;

  return wordId.startsWith(prefix) ? wordId.slice(prefix.length) : wordId;
}

function createContributionId(languageId: string, shortWordId: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return sanitizeFilename(`${getLanguageSlug(languageId)}-${shortWordId}-${Date.now().toString(36)}-${random}`);
}

function createContributionBatchId(languageId: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  return sanitizeFilename(`${getLanguageSlug(languageId)}-batch-${Date.now().toString(36)}-${random}`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "audio";
}

function getAudioFeedbackPath(source: AudioSource | undefined): string | undefined {
  if (!source?.src || source.kind === "tts") {
    return undefined;
  }

  return source.src;
}

function resolveAudioSourceForAnalysis(src: string): string {
  if (/^(https?:|data:|blob:|\/)/.test(src)) {
    return src;
  }

  const base = import.meta.env.BASE_URL || "./";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;

  return `${normalizedBase}${src}`;
}

function createNextPrompt(
  currentProgress: ReturnType<typeof loadProgress>,
  phonemePair: PhonemePair | null,
  sourceDataset: LanguageDataset,
): MatchingPrompt | undefined {
  const item = phonemePair
    ? selectNextMinimalPairForPhonemes(sourceDataset, phonemePair, currentProgress)
    : selectNextMinimalPair(sourceDataset, currentProgress);

  return item ? createMatchingPrompt(item) : undefined;
}

function createNextSortingPrompt(
  currentProgress: ReturnType<typeof loadProgress>,
  phonemePair: PhonemePair | null,
  sourceDataset: LanguageDataset,
): SortingPrompt | undefined {
  return phonemePair
    ? createSortingPromptForPhonemes(sourceDataset, phonemePair)
    : selectNextSortingPrompt(sourceDataset, currentProgress);
}

function readUrlState(): UrlState {
  if (typeof window === "undefined") {
    return {
      languageId: dataset.id,
      mode: "match",
      phonemePair: null,
      catalogTab: "phonemes",
      explorePhonemeId: null,
      contributionWordId: null,
      contributionModeOpen: false,
      ttsEnabled: false,
      showUnrecordedPhonemes: false,
      hideSortWordNames: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const explorePhonemeId = parsePhonemeId(params.get("explore"));
  const contributionParam = params.get("contribute");
  const contributionModeOpen = contributionParam === "mode";
  const contributionWordId = contributionModeOpen ? null : parseWordId(contributionParam);

  return {
    languageId: parseLanguageId(params.get("lang")) ?? dataset.id,
    mode: parseMode(params.get("mode")) ?? "match",
    phonemePair: parsePhonemePair(params.get("phonemes")),
    catalogTab: explorePhonemeId ? "phonemes" : parseCatalogTab(params.get("tab")) ?? "phonemes",
    explorePhonemeId,
    contributionWordId,
    contributionModeOpen,
    ttsEnabled: parseBooleanFlag(params.get("tts")),
    showUnrecordedPhonemes: parseBooleanFlag(params.get("showSounds")),
    hideSortWordNames: parseBooleanFlag(params.get("hideSortWords")),
  };
}

function writeUrlState(state: UrlState, historyMode: UrlHistoryMode): void {
  if (typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams(window.location.search);

  params.set("lang", state.languageId);
  params.set("mode", state.mode);

  if (state.phonemePair) {
    params.set("phonemes", state.phonemePair.join(","));
  } else {
    params.delete("phonemes");
  }

  params.set("tab", state.catalogTab);

  if (state.explorePhonemeId) {
    params.set("explore", state.explorePhonemeId);
  } else {
    params.delete("explore");
  }

  if (state.contributionModeOpen) {
    params.set("contribute", "mode");
  } else if (state.contributionWordId) {
    params.set("contribute", state.contributionWordId);
  } else {
    params.delete("contribute");
  }

  if (state.ttsEnabled) {
    params.set("tts", "1");
  } else {
    params.delete("tts");
  }

  if (state.showUnrecordedPhonemes) {
    params.set("showSounds", "1");
  } else {
    params.delete("showSounds");
  }

  if (state.hideSortWordNames) {
    params.set("hideSortWords", "1");
  } else {
    params.delete("hideSortWords");
  }

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextUrl === currentUrl) {
    return;
  }

  if (historyMode === "push") {
    window.history.pushState(null, "", nextUrl);
    return;
  }

  window.history.replaceState(null, "", nextUrl);
}

function parseMode(value: string | null): TrainingMode | null {
  return value === "match" || value === "sort" || value === "target" ? value : null;
}

function parseCatalogTab(value: string | null): CatalogTab | null {
  return value === "phonemes" || value === "contrasts" ? value : null;
}

function parseBooleanFlag(value: string | null): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseLanguageId(value: string | null): string | null {
  return languageDatasets.some((language) => sameLanguageId(language.id, value ?? undefined))
    ? getLanguageDataset(value ?? undefined).id
    : null;
}

function parsePhonemeId(value: string | null): PhonemeId | null {
  return value && isKnownPhoneme(value) ? value : null;
}

function parseWordId(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const direct = dataset.words.find((word) => word.id === value);

  if (direct) {
    return direct.id;
  }

  const prefixed = `${getLanguageSlug(dataset.id)}-word-${value}`;

  return dataset.words.some((word) => word.id === prefixed) ? prefixed : null;
}

function parsePhonemePair(value: string | null): PhonemePair | null {
  if (!value) {
    return null;
  }

  return toPhonemePair(value.split(",").map((part) => part.trim()).filter(isKnownPhoneme));
}

function toPhonemePair(values: readonly PhonemeId[]): PhonemePair | null {
  const first = values[0];
  const second = values[1];

  return values.length === 2 && first && second && first !== second
    ? [first, second]
    : null;
}

function isKnownPhoneme(value: string): value is PhonemeId {
  return dataset.phonemes.some((phoneme) => phoneme.id === value);
}

function samePhonemePair(left: readonly PhonemeId[], right: PhonemePair): boolean {
  return left.length === 2 && left.includes(right[0]) && left.includes(right[1]);
}

function phonemePairFromMatchingPrompt(prompt: MatchingPrompt | undefined): PhonemePair | null {
  if (!prompt) {
    return null;
  }

  const first = prompt.item.terms[0]?.phonemeId;
  const second = prompt.item.terms[1]?.phonemeId;

  return first && second && first !== second ? [first, second] : null;
}

function phonemePairFromSortingPrompt(prompt: SortingPrompt | undefined): PhonemePair | null {
  if (!prompt) {
    return null;
  }

  const first = prompt.groups[0]?.phonemeId;
  const second = prompt.groups[1]?.phonemeId;

  return first && second && first !== second ? [first, second] : null;
}

function getInitialDataset(): LanguageDataset {
  if (typeof window === "undefined") {
    return getLanguageDataset(undefined);
  }

  const params = new URLSearchParams(window.location.search);
  const urlLanguageId = parseLanguageId(params.get("lang"));

  return getLanguageDataset(urlLanguageId ?? loadLastLanguageId() ?? undefined);
}

function voiceMatchesSpeechLang(voice: SpeechSynthesisVoice, lang: string): boolean {
  const voiceLang = voice.lang.toLowerCase();
  const preferred = lang.toLowerCase();

  return voiceLang === preferred || voiceLang.startsWith(`${preferred.split("-")[0]}-`);
}
