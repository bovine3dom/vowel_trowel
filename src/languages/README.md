# Language Datasets

Each language exports a `LanguageDataset` from `src/languages/<language>/index.ts`.

The important units are:

- `phonemes`: stable IDs and IPA labels for sounds the app can track.
- `words`: reusable word resources with spelling, IPA, relevant supported phonemes, and audio.
- `contrasts`: the learner-facing training targets, such as French `/u/ vs /y/`.
- `audio`: one or more recordings for that word.

Matching and sorting drills are generated from `words`: for a contrast, the app finds words whose `phonemeIds` contain one target phoneme but not the other, then combines those word groups automatically. Named contrasts define the sound pair and learner-facing copy; they do not list individual word pairs.

Browser text-to-speech should not be treated as an IPA synthesizer. If you want a phoneme heading like `/y/` to play an isolated sound, add a real audio source to that phoneme. Without phoneme audio, the app plays a recorded example word that contains the phoneme.

Datasets can set `speechLangs` to prefer regional browser voices when optional TTS mode is enabled with `?t=1`, for example `fr-BE` or `fr-CH`. This only works when the user's browser/OS exposes matching voices; it is not a bundled speech engine and should not replace real recordings for merged or regional contrasts.

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

Example contrast entry:

```ts
{
  id: "fr-u-y",
  phonemeIds: ["fr-u", "fr-y"],
  label: "/u/ vs /y/",
  category: "vowel",
  description: "Back rounded /u/ against front rounded /y/."
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

If a word has no audio source, the app hides it from practice and exploration by default. Enable optional TTS mode with `?t=1` only for scaffolding; it should not be considered high-quality phoneme training content.
