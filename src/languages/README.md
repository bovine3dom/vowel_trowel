# Language Datasets

Each language exports a `LanguageDataset` from `src/languages/<language>/index.ts`.

The important units are:

- `phonemes`: stable IDs and IPA labels for sounds the app can track.
- `words`: reusable word resources with spelling, IPA, relevant supported phonemes, and audio.
- `contrasts`: the learner-facing training targets, such as French `/u/ vs /y/`.
- `contrast.minimalPairs`: two word IDs that differ by one target phoneme.
- `terms`: the side of a minimal pair, linking a `wordId` to the phoneme it realizes in that contrast.
- `audio`: one or more recordings for that word.

Sorting drills are generated from `words`: for a contrast, the app finds all words whose `phonemeIds` contain exactly one of that contrast's target phonemes.

Browser text-to-speech should not be treated as an IPA synthesizer. If you want a phoneme heading like `/y/` to play an isolated sound, add a real audio source to that phoneme. Without phoneme audio, the app plays an example word that contains the phoneme.

Datasets can set `speechLangs` to prefer regional browser voices for TTS fallback, for example `fr-BE` or `fr-CH`. This only works when the user's browser/OS exposes matching voices; it is not a bundled speech engine and should not replace real recordings for merged or regional contrasts.

Example phoneme audio entry:

```ts
{
  id: "fr-y",
  ipa: "/y/",
  label: "close front rounded vowel",
  category: "vowel",
  audio: [{ src: "audio/fr/phonemes/y.ogg", kind: "local" }]
}
```

Example word entry:

```ts
{
  id: "fr-word-roue",
  written: "roue",
  ipa: "/ʁu/",
  phonemeIds: ["fr-u"],
  audio: []
}
```

Example minimal pair entry inside a contrast:

```ts
{
  id: "fr-u-y-roue-rue",
  terms: [
    { wordId: "fr-word-roue", phonemeId: "fr-u" },
    { wordId: "fr-word-rue", phonemeId: "fr-y" }
  ]
}
```

Example audio entry:

```ts
{
  src: "audio/fr/roue--speaker-name.ogg",
  kind: "wiktionary",
  speaker: "Speaker name if known",
  accent: "France",
  license: "CC BY-SA 3.0",
  attribution: "Wiktionary contributors",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Fr-roue.ogg"
}
```

Files under `public/` are copied to the static build root, so `public/audio/fr/roue.ogg` is referenced as `audio/fr/roue.ogg`.

If a word has no audio source, the app falls back to browser speech synthesis using the dataset's `defaultSpeechLang`. That is useful for scaffolding but should not be considered high-quality phoneme training content.
