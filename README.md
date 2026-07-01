# vowel_trowel

Install dependencies:

```bash
bun install
```

Run locally:

```bash
bun run dev
```

Build the static client-only app:

```bash
bun run build
```

The built files in `dist/` can be hosted by a plain HTTP server. Language content lives under `src/languages/`, and static recordings live under `public/audio/`.

Run checks:

```bash
bun run check
bun run test:e2e
```

If Playwright browsers are missing, install Chromium once:

```bash
bunx playwright install chromium
```

## Audio Review Workflow

Use the wizard for the normal Wiktionary/Commons review loop:

```bash
bun run audio:wizard
```

By default it picks the first 12 words in French that do not have approved recordings, downloads up to 4 candidates per word, opens the terminal reviewer, then applies approved recordings to the app.

Focused examples:

```bash
bun run audio:wizard -- --words=brun,brin,jeune,jeûne
bun run audio:wizard -- --language=en-GB --words=ship,sheep
bun run audio:wizard -- --language=en-GB --limit=20 --max-candidates-per-word=6
```

Review controls are single-key: `a` approve, `r` reject, `s` skip, `p` play again, `u` undo the last decision, `w` skip the rest of the current word, and `q` quit.

The scraper uses MediaWiki APIs, includes your `git config user.email` in its `User-Agent`, retries transient HTTP failures, and respects `Retry-After`. Pass `--email=you@example.com` if git email is not set.

Downloaded review candidates go under ignored staging paths:

```text
public/audio/<language>/wiktionary/
```

Approved recordings are copied into committed app paths:

```text
public/audio/<language>/approved/
```

The apply step also writes `src/languages/<language>/audio.ts`. Each approved recording keeps license, attribution, accent, and source URL metadata in the audio module, and copied sidecar metadata stays next to the approved file when available.

## Manual Audio Commands

Generate a candidate report without the wizard:

```bash
bun run audio:wiktionary -- --words=brun,brin --download=all
```

Review downloaded candidates:

```bash
bun run audio:review
```

Apply approved candidates:

```bash
bun run audio:apply-reviewed
```

For British English, pass `--language=en-GB` to any audio command.

The reviewer updates the language-specific candidate report, each candidate metadata sidecar when present, and the language-specific review-state file. The scraper reads that review-state file on later runs and skips downloading candidates already approved or rejected. Use `--force-download-reviewed` if you intentionally want to download them again.

The app supports multiple recordings per word. Each training round randomly locks one recording per word, so repeated plays in the same round use the same audio; the next round can choose a different recording.
