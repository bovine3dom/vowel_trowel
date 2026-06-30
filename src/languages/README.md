# Language Datasets

Each language exports a `LanguageDataset` from `src/languages/<language>/index.ts`.

The important units are:

- `phonemes`: stable IDs and IPA labels for sounds the app can track.
- `contrasts`: the learner-facing training targets, such as French `/u/ vs /y/`.
- `minimalPairs`: two written forms that differ by one target phoneme.
- `terms`: the side of a minimal pair, linking one word to the phoneme it realizes in that contrast.
- `audio`: one or more recordings for that word.

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
