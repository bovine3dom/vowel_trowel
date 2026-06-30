# vowel_trowel

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

To build a static client-only app:

```bash
bun run build
```

The built files in `dist/` can be hosted by a plain HTTP server. Language content lives under `src/languages/`, and static recordings should be placed under `public/audio/`.

## Wiktionary audio candidates

Generate a local report of candidate French recordings from Wiktionary/Commons:

```bash
bun run audio:wiktionary
```

Useful focused run:

```bash
bun run audio:wiktionary -- --words=brun,brin,jeune,jeûne
```

The scraper uses MediaWiki APIs, includes your `git config user.email` in its `User-Agent`, retries transient HTTP failures, and respects `Retry-After`. It writes reports under `reports/` and does not modify the dataset automatically.

Optional download of detected Swiss/Belgian candidates:

```bash
bun run audio:wiktionary -- --words=brun,brin --download=regional
```

Download all candidates for a small review set:

```bash
bun run audio:wiktionary -- --words=brun,brin,jeune,jeûne --download=all
```

Downloaded files go under `public/audio/fr/wiktionary/`. Each file gets a `.metadata.json` sidecar with the Commons source URL, license, attribution, scoring, and review fields.

Interactive review workflow:

1. Download a focused candidate set:

```bash
bun run audio:wiktionary -- --words=brun,brin,jeune,jeûne --download=all
```

2. Review downloaded candidates from the terminal:

```bash
bun run audio:review
```

The reviewer auto-detects `mpv`, `ffplay`, or `play`. You can pass `--player=mpv`, `--no-autoplay`, `--no-play`, `--words=brun,brin`, or `--include-reviewed`.

3. Apply approved recordings to `src/languages/fr/audio.ts`:

```bash
bun run audio:apply-reviewed
```

The reviewer updates `reports/wiktionary-audio-candidates.json`, each candidate metadata sidecar when present, and `reports/wiktionary-audio-review-state.json`. The scraper reads that review-state file on later runs and skips downloading candidates already approved or rejected. Use `--force-download-reviewed` if you intentionally want to download them again.

Manual review is also possible by editing `reports/wiktionary-audio-candidates.json` and setting good candidates to:

```json
"review": {
  "status": "approved",
  "accent": "Swiss French",
  "notes": "Contrast preserved; clear recording."
}
```

The app supports multiple recordings per word. Each training round randomly locks one recording per word, so repeated plays in the same round use the same audio; the next round can choose a different recording.
