import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import {
  getAvailableSpeechVoices,
  playAudioSources,
  playTermAudio,
  selectSpeechVoice,
} from "./audio/playback";
import { frenchDataset } from "./languages/fr";
import type { MinimalPairTerm, PhonemeId } from "./languages/types";
import {
  canSubmitPrompt,
  createMatchingPrompt,
  createPromptSelections,
  gradeMatchingPrompt,
  selectNextMinimalPair,
  type MatchingPrompt,
  type PromptResult,
  type PromptSelections,
  type PromptSlot,
} from "./training/session";
import {
  canSubmitSortingPrompt,
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

const dataset = frenchDataset;
const SPEECH_VOICE_STORAGE_KEY = "vowel-trowel:tts-voice-uri";
type TrainingMode = "match" | "sort";

export default function App() {
  const initialProgress = loadProgress();
  const initialPrompt = createNextPrompt(initialProgress);
  const initialSortingPrompt = selectNextSortingPrompt(dataset, initialProgress);
  const [mode, setMode] = createSignal<TrainingMode>("match");
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

  const languageProgress = createMemo(() => getLanguageProgress(progress(), dataset.id));
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
  }));
  const frenchSpeechVoices = createMemo(() =>
    speechVoices().filter((voice) => voice.lang.toLowerCase().startsWith("fr")),
  );
  const activeSpeechVoice = createMemo(() => selectSpeechVoice(speechVoices(), speechSettings()));

  onMount(() => {
    const refreshVoices = () => setSpeechVoices(getAvailableSpeechVoices());

    refreshVoices();

    if (!("speechSynthesis" in window)) {
      return;
    }

    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    onCleanup(() => window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices));
  });

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

  const next = () => {
    const nextPrompt = createNextPrompt(progress());

    setPrompt(nextPrompt);
    setSelections(createPromptSelections(nextPrompt));
    setSelectedSlotId(null);
    setResult(null);
    setAudioError(null);
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

  const nextSorting = () => {
    const nextPrompt = selectNextSortingPrompt(dataset, progress());

    setSortingPrompt(nextPrompt);
    setSortingPlacements(createSortingPlacements(nextPrompt));
    setSelectedSortingTermId(null);
    setDraggedSortingTermId(null);
    setSortingResult(null);
    setAudioError(null);
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
    const nextPrompt = createNextPrompt(emptyProgress);
    const nextSortingPrompt = selectNextSortingPrompt(dataset, emptyProgress);

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

  return (
    <main class="app-shell">
      <section class="hero-panel">
        <div>
          <p class="eyebrow">Client-side phoneme drills</p>
          <h1>Vowel Trowel</h1>
          <p class="hero-copy">
            Hear two minimal-pair words, then match each recording to its spelling and IPA.
            Progress is stored locally and scheduled by the sounds you confuse most.
          </p>
        </div>
        <div class="language-card" aria-label="Current language">
          <span>Training</span>
          <strong>{dataset.name}</strong>
          <small>{minimalPairCount()} starter pairs</small>
        </div>
      </section>

      <nav class="mode-tabs" aria-label="Training mode">
        <button
          class={mode() === "match" ? "mode-tab selected" : "mode-tab"}
          type="button"
          onClick={() => setMode("match")}
        >
          Match sounds
        </button>
        <button
          class={mode() === "sort" ? "mode-tab selected" : "mode-tab"}
          type="button"
          onClick={() => setMode("sort")}
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
                onNext={nextSorting}
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
                onNext={next}
              />
            )}
          </Show>
        </Show>

        <aside class="progress-panel">
          <div class="panel-heading">
            <p class="eyebrow">Local progress</p>
            <h2>Adaptive memory</h2>
          </div>
          <div class="stat-grid">
            <Metric label="Attempts" value={String(totalAttempts())} />
            <Metric label="Contrasts" value={String(dataset.contrasts.length)} />
          </div>
          <VoicePanel
            voices={frenchSpeechVoices()}
            activeVoice={activeSpeechVoice()}
            selectedVoiceURI={selectedVoiceURI()}
            preferredLangs={dataset.speechLangs ?? [dataset.defaultSpeechLang]}
            onSelect={chooseSpeechVoice}
          />
          <div class="confusion-list">
            <h3>Top confusions</h3>
            <Show
              when={topConfusions().length > 0}
              fallback={<p class="muted">Mistakes will appear here as heard phoneme {"->"} chosen phoneme.</p>}
            >
              <For each={topConfusions()}>
                {(confusion) => (
                  <div class="confusion-row">
                    <span>
                      {phonemeLabel(confusion.heardPhonemeId)} {"->"}{" "}
                      {phonemeLabel(confusion.chosenPhonemeId)}
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
          <p class="eyebrow">Dataset sketch</p>
          <h2>French starter inventory</h2>
        </div>
        <div class="contrast-grid">
          <For each={dataset.contrasts}>
            {(contrast) => (
              <article class="contrast-card">
                <strong>{contrast.label}</strong>
                <p>{contrast.description}</p>
              </article>
            )}
          </For>
        </div>
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
  onNext: () => void;
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
        <p class="eyebrow">Current contrast</p>
        <h2>{contrast()?.label ?? props.prompt.item.contrastId}</h2>
      </div>
      <p class="instructions">
        Select a sound to play it, then choose the matching written form. Repeat until every
        sound has one word.
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
                    {slot.term.word.audio.length ? "Recorded audio" : "TTS fallback"}
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
                    Sample {slot?.label}: heard {slot?.term.word.written} {slot?.term.word.ipa}, chose{" "}
                    {chosen?.word.written} {chosen?.word.ipa}
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
          <button class="primary-button" type="button" onClick={props.onNext}>
            Next pair
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
  onNext: () => void;
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
        <h2>{contrast()?.label ?? props.prompt.contrastId}</h2>
      </div>
      <p class="instructions">
        Put each written word into the group for the phoneme it contains. Tap a word to hear
        it; tap a phoneme heading to hear an example; drag a word into a group, or tap a word
        and then tap a group.
      </p>
      <p class="interaction-hint">
        <Show when={selectedTerm()} fallback="Tap or drag a word from the bag.">
          {(term) => <>Selected {term().word.written}. Choose a phoneme group.</>}
        </Show>
      </p>

      <Show when={props.audioError}>
        {(message) => <p class="error-message">{message()}</p>}
      </Show>

      <section
        class="sort-bag"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropOnGroup(event, null)}
      >
        <div class="column-title">
          <h3>Word bag</h3>
          <span>IPA appears after checking</span>
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
                <span>{group.label}</span>
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
                    {term?.word.written}: {phonemeLabel(answer.heardPhonemeId)} word placed in{" "}
                    {phonemeLabel(answer.chosenPhonemeId)}
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
          <button class="primary-button" type="button" onClick={props.onNext}>
            Next sort
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

function VoicePanel(props: {
  voices: readonly SpeechSynthesisVoice[];
  activeVoice: SpeechSynthesisVoice | undefined;
  selectedVoiceURI: string | null;
  preferredLangs: readonly string[];
  onSelect: (voiceURI: string) => void;
}) {
  return (
    <section class="voice-panel">
      <h3>TTS voice</h3>
      <p>
        Auto prefers {props.preferredLangs.join(", ")}. If your browser exposes Belgian or
        Swiss French, select it here.
      </p>
      <Show
        when={props.voices.length > 0}
        fallback={<p class="muted">No French browser voices detected yet.</p>}
      >
        <label class="voice-select-label">
          <span>Browser voice</span>
          <select
            value={props.selectedVoiceURI ?? ""}
            onInput={(event) => props.onSelect(event.currentTarget.value)}
          >
            <option value="">Auto regional preference</option>
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
        For contrasts like brun/brin, real recordings are still more reliable than TTS.
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

function EmptyDataset() {
  return (
    <section class="training-panel">
      <h2>No training content yet</h2>
      <p>Add minimal pairs to `src/languages/fr/index.ts` to start a session.</p>
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

function phonemeHasAudio(phonemeId: PhonemeId): boolean {
  return Boolean(dataset.phonemes.find((phoneme) => phoneme.id === phonemeId)?.audio?.length);
}

function minimalPairCount(): number {
  return dataset.contrasts.reduce((total, contrast) => total + contrast.minimalPairs.length, 0);
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

function createNextPrompt(currentProgress: ReturnType<typeof loadProgress>): MatchingPrompt | undefined {
  const item = selectNextMinimalPair(dataset, currentProgress);
  return item ? createMatchingPrompt(item) : undefined;
}
