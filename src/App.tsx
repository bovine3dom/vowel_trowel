import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

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
import { getLanguageDataset, languageDatasets, sameLanguageId } from "./languages";
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
const renderedSpectrograms = new WeakMap<PrecomputedSpectrogram, HTMLCanvasElement>();
type TrainingMode = "match" | "sort";
type CatalogTab = "phonemes" | "contrasts";
type PhonemePair = readonly [PhonemeId, PhonemeId];
type UrlHistoryMode = "push" | "replace";

interface UrlState {
  languageId: string;
  mode: TrainingMode;
  phonemePair: PhonemePair | null;
  catalogTab: CatalogTab;
  explorePhonemeId: PhonemeId | null;
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
  const currentAudioCredits = createMemo(() => {
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
    updateUrl({ catalogTab: "phonemes", explorePhonemeId: phonemeId });
  };

  const closePhonemeExplorer = () => {
    setExplorePhonemeId(null);
    updateUrl({ explorePhonemeId: null }, "replace");
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

  const playWordRecording = async (word: WordEntry) => {
    setAudioError(null);

    try {
      await playAudioSources(word.audio, word.speechText ?? word.written, speechSettings());
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
      await playAudioSources([source], word.speechText ?? word.written, speechSettings());
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
      await playTermAudio(slot.term, speechSettings());
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : "Audio playback failed.");
    }
  };

  const playWord = async (term: MinimalPairTerm) => {
    setAudioError(null);

    try {
      await playTermAudio(term, speechSettings());
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

      await playTermAudio(group.exampleTerm, speechSettings());
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
        <div class="language-card" aria-label="Current language">
          <span>Practising</span>
          <strong>{dataset.name}</strong>
          <small>{minimalPairCount(practiceDataset())} word pairs</small>
          <label class="language-select-label">
            <span>Language</span>
            <select value={dataset.id} onInput={(event) => chooseLanguage(event.currentTarget.value)}>
              <For each={languageDatasets}>
                {(language) => <option value={language.id}>{language.name}</option>}
              </For>
            </select>
          </label>
        </div>
      </section>

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
          onWordRecordingPlay={playWordRecording}
          onWordTtsPlay={playWordTts}
          onTrackPlay={playAudioTrack}
        />
        <AudioCreditsPanel credits={currentAudioCredits()} ttsEnabled={ttsEnabled()} />
      </section>
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
  const selectedSlot = createMemo(() =>
    props.prompt.slots.find((slot) => slot.id === props.selectedSlotId),
  );

  return (
    <section class="training-panel">
      <div class="panel-heading">
        <p class="eyebrow">Listen for</p>
        <h2 class="ipa-heading">{contrast()?.label ?? props.prompt.item.contrastId}</h2>
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
        <h2 class="ipa-heading">{contrast()?.label ?? props.prompt.contrastId}</h2>
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
  onWordRecordingPlay: (word: WordEntry) => void;
  onWordTtsPlay: (word: WordEntry) => void;
  onTrackPlay: (word: WordEntry, source: AudioSource) => void;
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
              onWordRecordingPlay={props.onWordRecordingPlay}
              onWordTtsPlay={props.onWordTtsPlay}
              onTrackPlay={props.onTrackPlay}
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
  onWordRecordingPlay: (word: WordEntry) => void;
  onWordTtsPlay: (word: WordEntry) => void;
  onTrackPlay: (word: WordEntry, source: AudioSource) => void;
}) {
  const words = createMemo(() => wordsForPhoneme(props.phoneme.id, props.availableDataset));

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
                    onClick={() => props.onWordRecordingPlay(word)}
                  >
                    Play recording
                  </button>
                  <Show when={props.ttsEnabled}>
                    <button class="small-button" type="button" onClick={() => props.onWordTtsPlay(word)}>
                      Browser voice
                    </button>
                  </Show>
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
          <span class={`spectrogram-status ${props.visualization.status}`}>
            {spectrogramStatusLabel(props.visualization)}
          </span>
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
        <button
          class="small-button spectrogram-replay"
          type="button"
          disabled={!props.visualization.replay}
          onClick={() => void props.visualization.replay?.().catch(() => undefined)}
        >
          Replay
        </button>
      </div>
    </section>
  );
}

function spectrogramStatusLabel(visualization: PlaybackVisualizationState): string {
  if (visualization.status === "playing") {
    return visualization.mode === "voice" ? "Voice" : "Playing";
  }

  if (visualization.status === "ended") {
    return "Held";
  }

  if (visualization.status === "error") {
    return "Error";
  }

  return "Ready";
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
  return `${phonemeLabel(phonemePair[0])} vs ${phonemeLabel(phonemePair[1])}`;
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
      ttsEnabled: false,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const explorePhonemeId = parsePhonemeId(params.get("explore"));

  return {
    languageId: parseLanguageId(params.get("lang")) ?? dataset.id,
    mode: parseMode(params.get("mode")) ?? "match",
    phonemePair: parsePhonemePair(params.get("phonemes")),
    catalogTab: explorePhonemeId ? "phonemes" : parseCatalogTab(params.get("tab")) ?? "phonemes",
    explorePhonemeId,
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
