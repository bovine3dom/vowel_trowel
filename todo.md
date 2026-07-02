# Todo

## Audiobook Word Harvesting

Goal: add a second audio-candidate source for words that Wiktionary/Commons does not cover well.

Preferred source:

- LibriVox public-domain audiobooks.
- Matching public-domain transcripts, usually from Project Gutenberg or Internet Archive.

Possible workflow:

1. Pick target-language LibriVox books with clear recordings and usable transcripts.
2. Download chapter audio plus matching transcript.
3. Run forced alignment to get word-level timestamps.
4. Search aligned transcript for app words missing reviewed recordings.
5. Extract word-sized clips with a little context padding.
6. Generate candidate metadata with book, chapter, reader, timestamp, license, source URL, and transcript match.
7. Send extracted clips through the existing review/apply workflow.

Tools to evaluate:

- Montreal Forced Aligner: likely best serious option for word-level alignment.
- aeneas: simpler audiobook/text alignment, probably weaker for precise word clips.
- WhisperX: practical timestamping, but check model/dependency/licensing details first.
- Gentle: older English-focused option.

Constraints and cautions:

- Keep this candidate-only; never auto-approve harvested clips.
- Preserve per-recording attribution/source metadata.
- Mark harvested clips as in-context audio, not isolated dictionary pronunciation.
- Watch for coarticulation, sentence prosody, reductions, background noise, and overlapping speech.
- Continue preferring reviewed Wiktionary/Commons word recordings when available.

Possible commands/scripts:

- `audio:librivox`
- `audio:harvest`
