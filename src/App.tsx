import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { strToU8, zipSync } from "fflate";

import {
  getAvailableSpeechVoices,
  getPlaybackVisualizationState,
  playAudioSources,
  playTermAudio,
  selectSpeechVoice,
  subscribePlaybackVisualization,
  type PrecomputedSpectrogram,
  type PlaybackVisualizationState,
} from "./audio/playback";
import { getLanguageDataset, getLanguageSlug, languageDatasets, sameLanguageId } from "./languages";
import type { AudioSource, LanguageDataset, MinimalPairTerm, Phoneme, PhonemeContrast, PhonemeId, WordEntry } from "./languages/types";
import {
  canSubmitPrompt,
  createMatchingPrompt,
  createPromptSelections,
  gradeMatchingPrompt,
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

const dataset = getInitialDataset();
const SPEECH_VOICE_STORAGE_KEY = "vowel-trowel:tts-voice-uri";
const CONTRIBUTION_DETAILS_STORAGE_KEY = "vowel-trowel:contribution-details:v1";
const renderedSpectrograms = new WeakMap<PrecomputedSpectrogram, HTMLCanvasElement>();
type TrainingMode = "match" | "sort";
type CatalogTab = "phonemes" | "contrasts";
type PhonemePair = readonly [PhonemeId, PhonemeId];
type UrlHistoryMode = "push" | "replace";
type ContributionLicence = "CC0-1.0" | "CC-BY-4.0";

interface ContributionDetails {
  schemaVersion: 1;
  licence: ContributionLicence;
  speakerName: string;
  accent: string;
}

interface UrlState {
  languageId: string;
  mode: TrainingMode;
  phonemePair: PhonemePair | null;
  catalogTab: CatalogTab;
  explorePhonemeId: PhonemeId | null;
  contributionWordId: string | null;
  ttsEnabled: boolean;
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
  const initialActivePhonemePair = initialUrlState.phonemePair
    ?? (initialUrlState.mode === "sort"
      ? phonemePairFromSortingPrompt(initialSortingPrompt)
      : phonemePairFromMatchingPrompt(initialPrompt));
  const [mode, setMode] = createSignal<TrainingMode>(initialUrlState.mode);
  const [lockedPhonemePair, setLockedPhonemePair] = createSignal<PhonemePair | null>(initialUrlState.phonemePair);
  const [activePhonemePair, setActivePhonemePair] = createSignal<PhonemePair | null>(initialActivePhonemePair);
  const [draftPhonemeIds, setDraftPhonemeIds] = createSignal<readonly PhonemeId[]>(initialActivePhonemePair ?? []);
  const [catalogTab, setCatalogTab] = createSignal<CatalogTab>(initialUrlState.catalogTab);
  const [explorePhonemeId, setExplorePhonemeId] = createSignal<PhonemeId | null>(initialUrlState.explorePhonemeId);
  const [contributionWordId, setContributionWordId] = createSignal<string | null>(initialUrlState.contributionWordId);
  const [ttsEnabled, setTtsEnabled] = createSignal(initialUrlState.ttsEnabled);
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
  const contributionWord = createMemo(() => {
    const wordId = contributionWordId();

    return wordId ? dataset.words.find((word) => word.id === wordId) : undefined;
  });
  const currentAudioCredits = createMemo(() => {
    if (contributionWordId()) {
      return [];
    }

    const exploredPhonemeId = explorePhonemeId();

    if (exploredPhonemeId) {
      return collectWordAudioCredits(wordsForPhoneme(exploredPhonemeId, practiceDataset()));
    }

    return mode() === "sort"
      ? collectTermAudioCredits(sortingPrompt()?.wordCards ?? [])
      : collectTermAudioCredits(prompt()?.item.terms ?? []);
  });

  onMount(() => {
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

    setMode(state.mode);
    setLockedPhonemePair(state.phonemePair);
    setActivePhonemePair(nextActivePair);
    setDraftPhonemeIds(nextActivePair ?? []);
    setCatalogTab(state.catalogTab);
    setExplorePhonemeId(state.explorePhonemeId);
    setContributionWordId(state.contributionWordId);
    setTtsEnabled(state.ttsEnabled);

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
      ttsEnabled: patch.ttsEnabled ?? ttsEnabled(),
    }, historyMode);
  };

  onMount(() => updateUrl({ phonemePair: activePhonemePair() }, "replace"));

  const chooseMode = (nextMode: TrainingMode) => {
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
    updateUrl({ contributionWordId: word.id });
  };

  const closeContributionPage = () => {
    setContributionWordId(null);
    updateUrl({ contributionWordId: null }, "replace");
  };

  const selectPhonemeForDraft = (phonemeId: PhonemeId) => {
    const current = draftPhonemeIds();
    const nextDraft = current.includes(phonemeId)
      ? current.filter((candidate) => candidate !== phonemeId)
      : current.length >= 2
        ? [phonemeId]
        : [...current, phonemeId];

    setDraftPhonemeIds(nextDraft);

    const nextPair = toPhonemePair(nextDraft);

    if (nextPair) {
      choosePhonemePair(nextPair);
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

  const playWord = async (term: MinimalPairTerm) => {
    setAudioError(null);

    try {
      await playTermAudio(
        term,
        speechSettings(),
        undefined,
        getAudioFeedbackPath(selectedAudioForTerm(term)),
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

    await playWord(term);
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
      </nav>

      <section class="workspace-grid">
        <Show when={mode() === "match"} fallback={
          <Show when={sortingPrompt()} fallback={<EmptyDataset />}>
            {(activePrompt) => (
              <SortingPanel
                prompt={activePrompt()}
                placements={sortingPlacements()}
                selectedTermId={selectedSortingTermId()}
                result={sortingResult()}
                audioError={audioError()}
                onWordClick={selectSortingWord}
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
          tab={catalogTab()}
          activePhonemePair={activePhonemePair()}
          draftPhonemeIds={draftPhonemeIds()}
          explorePhonemeId={explorePhonemeId()}
          audioError={audioError()}
          availableDataset={practiceDataset()}
          ttsEnabled={ttsEnabled()}
          onTabChange={chooseCatalogTab}
          onPhonemeSelect={selectPhonemeForDraft}
          onPhonemeExplore={explorePhoneme}
          onExploreClose={closePhonemeExplorer}
          onPairSelect={choosePhonemePair}
          onPairClear={clearPhonemePair}
          onRandomRecordingPlay={playRandomWordRecording}
          onWordTtsPlay={playWordTts}
          onTrackPlay={playAudioTrack}
          onContribute={openContributionPage}
        />
        <AudioCreditsPanel credits={currentAudioCredits()} ttsEnabled={ttsEnabled()} />
      </section>

          </>
        }
      >
        {(word) => (
          <ContributionPage
            language={dataset}
            word={word()}
            onBack={closeContributionPage}
          />
        )}
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

function SortingPanel(props: {
  prompt: SortingPrompt;
  placements: SortingPlacements;
  selectedTermId: string | null;
  result: PromptResult | null;
  audioError: string | null;
  onWordClick: (term: MinimalPairTerm) => void;
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
      <p class="interaction-hint">
        <Show when={selectedTerm()} fallback="Tap or drag a word from the bag.">
          {(term) => <>Selected {term().word.written}. Choose a sound group.</>}
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
          <span>Pronunciation appears after checking</span>
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
      <span class="word-text">{props.term.word.written}</span>
      <Show when={props.showIpa}>
        <span class="word-ipa">{props.term.word.ipa}</span>
      </Show>
    </button>
  );
}

function CatalogPanel(props: {
  tab: CatalogTab;
  activePhonemePair: PhonemePair | null;
  draftPhonemeIds: readonly PhonemeId[];
  explorePhonemeId: PhonemeId | null;
  audioError: string | null;
  availableDataset: LanguageDataset;
  ttsEnabled: boolean;
  onTabChange: (tab: CatalogTab) => void;
  onPhonemeSelect: (phonemeId: PhonemeId) => void;
  onPhonemeExplore: (phonemeId: PhonemeId) => void;
  onExploreClose: () => void;
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
              activePhonemePair={props.activePhonemePair}
              draftPhonemeIds={props.draftPhonemeIds}
              onPhonemeSelect={props.onPhonemeSelect}
              onPhonemeExplore={props.onPhonemeExplore}
              onPairSelect={props.onPairSelect}
              onPairClear={props.onPairClear}
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
  activePhonemePair: PhonemePair | null;
  draftPhonemeIds: readonly PhonemeId[];
  onPhonemeSelect: (phonemeId: PhonemeId) => void;
  onPhonemeExplore: (phonemeId: PhonemeId) => void;
  onPairSelect: (phonemePair: PhonemePair, mode?: TrainingMode) => void;
  onPairClear: () => void;
}) {
  return (
    <>
      <div class="phoneme-selection-bar">
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
        <For each={dataset.phonemes}>
          {(phoneme) => (
            <article class={phonemeCardClass(phoneme, props.draftPhonemeIds, props.activePhonemePair)}>
              <button class="phoneme-main" type="button" onClick={() => props.onPhonemeSelect(phoneme.id)}>
                <span class="phoneme-ipa">{phoneme.ipa}</span>
                <strong>{phoneme.label}</strong>
                <small>{phoneme.category}</small>
              </button>
              <Show when={phoneme.notes}>
                {(notes) => <p>{notes()}</p>}
              </Show>
              <button class="text-button compact" type="button" onClick={() => props.onPhonemeExplore(phoneme.id)}>
                Explore words
              </button>
            </article>
          )}
        </For>
      </div>
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
  const words = createMemo(() =>
    wordsForPhoneme(props.phoneme.id, showMissingWords() ? dataset : props.availableDataset)
  );
  const hiddenWordCount = createMemo(() =>
    wordsForPhoneme(props.phoneme.id, dataset).length - wordsForPhoneme(props.phoneme.id, props.availableDataset).length
  );

  return (
    <section class="phoneme-explorer">
      <button class="text-button compact" type="button" onClick={props.onBack}>
        Back to sounds
      </button>
      <div class="phoneme-explorer-heading">
        <span class="phoneme-ipa large">{props.phoneme.ipa}</span>
        <div>
          <h3>{props.phoneme.label}</h3>
          <p>{props.phoneme.notes ?? `${words().length} words here use this sound.`}</p>
        </div>
      </div>

      <Show when={props.audioError}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <div class="explore-word-list">
        <Show when={words().length > 0} fallback={<p class="muted">{props.ttsEnabled ? "No words for this sound yet." : "No recorded words for this sound yet."}</p>}>
          <For each={words()}>
          {(word) => (
            <article class="explore-word-card">
              <div class="explore-word-heading">
                <div>
                  <strong>{word.written}</strong>
                  <span class="ipa-text">{word.ipa}</span>
                </div>
                <div class="explore-actions">
                  <button
                    class="small-button"
                    type="button"
                    disabled={word.audio.length === 0}
                    onClick={() => props.onRandomRecordingPlay(word)}
                  >
                    Play random recording
                  </button>
                  <Show when={props.ttsEnabled}>
                    <button class="small-button" type="button" onClick={() => props.onWordTtsPlay(word)}>
                      Browser voice
                    </button>
                  </Show>
                  <button class="small-button" type="button" onClick={() => props.onContribute(word)}>
                    Contribute a recording
                  </button>
                </div>
              </div>

              <Show
                when={word.audio.length > 0}
                fallback={props.ttsEnabled
                  ? <p class="muted">No recording yet; browser voice is available.</p>
                  : <p class="muted">No recording yet.</p>}
              >
                <div class="track-list">
                  <For each={word.audio}>
                    {(source, index) => (
                      <div class="track-row">
                        <button class="text-button compact" type="button" onClick={() => props.onTrackPlay(word, source)}>
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
          )}
          </For>
        </Show>
        <label class="explorer-option">
          <input
            type="checkbox"
            checked={showMissingWords()}
            onInput={(event) => setShowMissingWords(event.currentTarget.checked)}
          />
          Show words missing recordings
          <Show when={hiddenWordCount() > 0}>
            <span>({hiddenWordCount()} hidden)</span>
          </Show>
        </label>
      </div>
    </section>
  );
}

function ContributionPage(props: {
  language: LanguageDataset;
  word: WordEntry;
  onBack: () => void;
}) {
  const savedContributionDetails = loadContributionDetails();
  const countdownSecondsTotal = 3;
  const countdownDurationMs = countdownSecondsTotal * 1000;
  const recordingDurationMs = 2000;
  const recordingTimelineDurationMs = countdownDurationMs + recordingDurationMs;
  let recorder: MediaRecorder | undefined;
  let activeStream: MediaStream | undefined;
  let countdownInterval: number | undefined;
  let stopTimeout: number | undefined;
  let timelineFrame: number | undefined;
  let chunks: BlobPart[] = [];
  const [status, setStatus] = createSignal<"idle" | "preparing" | "countdown" | "recording" | "recorded">("idle");
  const [countdownSeconds, setCountdownSeconds] = createSignal(countdownSecondsTotal);
  const [timelineElapsedMs, setTimelineElapsedMs] = createSignal(0);
  const [recordingBlob, setRecordingBlob] = createSignal<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = createSignal<string | null>(null);
  const [licence, setLicence] = createSignal<ContributionLicence>(savedContributionDetails.licence);
  const [speakerName, setSpeakerName] = createSignal(savedContributionDetails.speakerName);
  const [accent, setAccent] = createSignal(savedContributionDetails.accent);
  const [error, setError] = createSignal<string | null>(null);

  const recorderAvailable = () =>
    typeof navigator !== "undefined"
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== "undefined";
  const requiresAttributionName = createMemo(() => licence() === "CC-BY-4.0");
  const canDownload = createMemo(() =>
    Boolean(recordingBlob()) && (!requiresAttributionName() || speakerName().trim().length > 0)
  );
  const recordingInProgress = createMemo(() => status() === "preparing" || status() === "countdown" || status() === "recording");
  const countdownProgressPercent = createMemo(() =>
    Math.min(100, Math.max(0, (timelineElapsedMs() / countdownDurationMs) * 100))
  );
  const recordingProgressPercent = createMemo(() =>
    Math.min(100, Math.max(0, ((timelineElapsedMs() - countdownDurationMs) / recordingDurationMs) * 100))
  );
  const timelineMessage = createMemo(() => {
    if (status() === "preparing") {
      return "Preparing the microphone, then the countdown will begin.";
    }

    if (status() === "countdown") {
      return `Get ready. Recording starts in ${countdownSeconds()}...`;
    }

    if (status() === "recording") {
      return `Recording now. Say “${props.word.written}”.`;
    }

    if (status() === "recorded") {
      return "Recorded. Listen back, then download it if it sounds right.";
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

    return recordingBlob() ? "Record again" : "Start recording";
  });

  createEffect(() => {
    const url = recordingUrl();

    onCleanup(() => {
      if (url) {
        URL.revokeObjectURL(url);
      }
    });
  });

  createEffect(() => {
    saveContributionDetails({
      schemaVersion: 1,
      licence: licence(),
      speakerName: speakerName().trim(),
      accent: accent().trim(),
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

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" });

        clearRecordingTimers();
        setTimelineElapsedMs(recordingTimelineDurationMs);
        stopStream(activeStream);
        activeStream = undefined;
        recorder = undefined;
        setRecordingBlob(blob);
        setRecordingUrl(URL.createObjectURL(blob));
        setStatus("recorded");
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
    let remaining = countdownSecondsTotal;

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
      }, recordingDurationMs);
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
      const elapsed = Math.min(recordingTimelineDurationMs, now - startedAt);

      setTimelineElapsedMs(elapsed);
      if (elapsed < recordingTimelineDurationMs && (status() === "countdown" || status() === "recording")) {
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

  const downloadBundle = async () => {
    const blob = recordingBlob();

    if (!blob || !canDownload()) {
      return;
    }

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
          Download a bundle and send it for review before it is added to the site.
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
          <dt>Sound IDs</dt>
          <dd>{props.word.phonemeIds.join(", ")}</dd>
        </div>
      </dl>

      <div class="contribution-grid">
        <section class="contribution-card recorder-card">
          <p class="eyebrow">Step 1</p>
          <h3>Record your sample</h3>
          <p class="contribution-card-copy">Use a quiet room. After the countdown, say the word once, naturally.</p>
          <div
            class="recording-timeline"
            data-state={status()}
            role="progressbar"
            aria-label="Recording countdown and capture progress"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={Math.round(timelineElapsedMs() / 100) / 10}
            style={`--countdown-progress: ${countdownProgressPercent()}%; --recording-progress: ${recordingProgressPercent()}%;`}
          >
            <div class="recording-timeline-bar" aria-hidden="true">
              <div class="recording-timeline-segment countdown-segment">
                <div class="recording-timeline-segment-fill countdown-fill" />
                <span>Get ready</span>
                <strong>3s</strong>
              </div>
              <div class="recording-timeline-segment recording-segment">
                <div class="recording-timeline-segment-fill recording-fill" />
                <span>Speak</span>
                <strong>2s</strong>
              </div>
            </div>
            <div class="recording-timeline-labels" aria-hidden="true">
              <span>Countdown</span>
              <span>Recording</span>
            </div>
            <p class="recording-timeline-help">{timelineMessage()}</p>
          </div>
          <Show when={recorderAvailable()} fallback={
            <p class="error-message">Recording is not available in this browser.</p>
          }>
            <div class="recorder-actions">
              <button
                class="primary-button"
                type="button"
                disabled={recordingInProgress()}
                onClick={() => void startRecording()}
              >
                {recordButtonText()}
              </button>
              <button class="small-button" type="button" disabled={!recordingBlob() || recordingInProgress()} onClick={discardRecording}>
                Discard
              </button>
            </div>
          </Show>
          <Show when={recordingUrl()}>
            {(url) => (
              <div class="recording-preview">
                <p>Listen back before downloading.</p>
                <audio controls src={url()} />
              </div>
            )}
          </Show>
          <Show when={error()}>
            {(message) => <p class="error-message">{message()}</p>}
          </Show>
        </section>

        <section class="contribution-card contribution-form-card">
          <p class="eyebrow">Step 2</p>
          <h3>Licence and download</h3>
          <p class="contribution-card-copy">CC0 is easiest. Pick CC BY 4.0 if you require your name to be attached.</p>
          <label class="field-label">
            Licence
            <select value={licence()} onInput={(event) => setLicence(event.currentTarget.value as ContributionLicence)}>
              <option value="CC0-1.0">CC0 1.0 public domain dedication</option>
              <option value="CC-BY-4.0">CC BY 4.0 attribution</option>
            </select>
          </label>
          <label class="field-label">
            Name {requiresAttributionName() ? <span>(required for CC BY 4.0)</span> : <span>(optional for CC0)</span>}
            <input
              type="text"
              value={speakerName()}
              onInput={(event) => setSpeakerName(event.currentTarget.value)}
              placeholder="How you want to be credited"
            />
          </label>
          <label class="field-label">
            Accent or region <span>(optional)</span>
            <input
              type="text"
              value={accent()}
              onInput={(event) => setAccent(event.currentTarget.value)}
              placeholder="e.g. Belgian French"
            />
          </label>
          <button class="primary-button" type="button" disabled={!canDownload()} onClick={() => void downloadBundle()}>
            Download contribution zip
          </button>
          <Show when={requiresAttributionName() && speakerName().trim().length === 0}>
            <p class="muted">CC BY 4.0 needs a name for attribution. CC0 does not.</p>
          </Show>
        </section>

        <section class="contribution-card contribution-send-card">
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
    }

    stopDrawing();

    if (visualization.status === "playing" && visualization.spectrogram) {
      stopSpectrogram = drawPrecomputedSpectrogram(canvas, visualization, {
        get: () => revealedColumn,
        set: (column) => { revealedColumn = column; },
      });
      return;
    }

    if (visualization.status === "ended" && visualization.spectrogram) {
      revealedColumn = paintSpectrogramToProgress(canvas, visualization, 1, revealedColumn);
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
  return dataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.ipa ?? phonemeId;
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
): string {
  const classes = ["phoneme-card"];

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

function stopStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
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
    language: {
      id: options.language.id,
      slug: getLanguageSlug(options.language.id),
      name: options.language.name,
      autonym: options.language.autonym,
    },
    word: {
      id: options.word.id,
      shortId: shortWordId,
      written: options.word.written,
      ipa: options.word.ipa,
      phonemeIds: options.word.phonemeIds,
      speechText: options.word.speechText,
    },
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
      ttsEnabled: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const explorePhonemeId = parsePhonemeId(params.get("explore"));
  const contributionWordId = parseWordId(params.get("contribute"));

  return {
    languageId: parseLanguageId(params.get("lang")) ?? dataset.id,
    mode: parseMode(params.get("mode")) ?? "match",
    phonemePair: parsePhonemePair(params.get("phonemes")),
    catalogTab: explorePhonemeId ? "phonemes" : parseCatalogTab(params.get("tab")) ?? "phonemes",
    explorePhonemeId,
    contributionWordId,
    ttsEnabled: parseBooleanFlag(params.get("tts")),
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

  if (state.contributionWordId) {
    params.set("contribute", state.contributionWordId);
  } else {
    params.delete("contribute");
  }

  if (state.ttsEnabled) {
    params.set("tts", "1");
  } else {
    params.delete("tts");
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
  return value === "match" || value === "sort" ? value : null;
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

  return getLanguageDataset(new URLSearchParams(window.location.search).get("lang") ?? undefined);
}

function voiceMatchesSpeechLang(voice: SpeechSynthesisVoice, lang: string): boolean {
  const voiceLang = voice.lang.toLowerCase();
  const preferred = lang.toLowerCase();

  return voiceLang === preferred || voiceLang.startsWith(`${preferred.split("-")[0]}-`);
}
