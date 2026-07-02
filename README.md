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

By default it queues words from target phoneme sets that have fewer than 4 approved recordings, downloads up to 4 candidates per word, opens the terminal reviewer, then applies approved recordings to the app. If you pass `--words`, those words seed the target phoneme sets to fill; the wizard may add other words from the same sets until the coverage target can be reached.

The discovery step prints progress bars for Wiktionary page fetches, Commons metadata fetches, and downloads. It also checks nearby Wiktionary IPA claims for each audio template. Candidates with an explicit IPA mismatch are skipped by default, which helps avoid homograph mistakes such as English `live` /lɪv/ versus /laɪv/.

Focused examples:

```bash
bun run audio:wizard -- --words=brun,brin,jeune,jeûne
bun run audio:wizard -- --language=en-GB --words=ship,sheep
bun run audio:wizard -- --language=en-GB --coverage-target=6 --limit=20 --max-candidates-per-word=6
```

Use `--coverage-target=N` to change the goal from 4 approved recordings per target phoneme set. Use `--limit=N` only when you want to cap how many words are queued from the under-covered sets.

The wizard can also use local MSWC/Common Voice extracts:

```bash
bun run audio:wizard -- --source=mswc --language=en-GB --words=bed --download=all
```

By default MSWC discovery reads from the parent-level prototype folder:

```text
../ml-commons-prototype/extracted/mswc_full/<language>/clips/<word>/*.opus
../ml-commons-prototype/extracted/mozilla/cv-corpus-26.0-2026-06-12/<language>/validated.tsv
```

It does not require `*_splits.csv`; it only enumerates the specific `clips/<word>/` directories for the words you request. Use `--mswc-root=/path/to/mswc_full` or `--cv-validated=/path/to/validated.tsv` if your local paths differ.

MSWC is grapheme-based, not IPA-based. The MSWC report derives target phoneme IDs from the app's minimal-pair definitions and prints them during review. Use `--target-phoneme=word:phoneme` when you need to choose the phoneme explicitly, for example `--target-phoneme=live:en-gb-kit`. All MSWC candidates still require manual listening before approval.

For French MSWC/Common Voice metadata, Swiss and Belgian French accents are prioritised when present. French-from-France candidates are only excluded automatically for merger-sensitive contrasts currently configured for `fr-un` vs `fr-in`, such as `brun`/`brin`; other French-from-France candidates are not globally blacklisted. Pass `--include-merged-france` if you intentionally want to inspect those excluded candidates.

Use `--include-ipa-mismatches` only when you intentionally want to inspect files that Wiktionary appears to mark with a different pronunciation. Use `--no-progress` for quieter logs.

Review controls are single-key: `a` approve, `r` reject, `s` skip, `p` play again, `u` undo the last decision, `w` skip the rest of the current word, and `q` quit.

The scraper uses MediaWiki APIs, includes your `git config user.email` in its `User-Agent`, retries transient HTTP failures, and respects `Retry-After`. Pass `--email=you@example.com` if git email is not set.

Downloaded review candidates go under ignored staging paths:

```text
public/audio/<language>/wiktionary/
public/audio/<language>/mswc/
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
bun run audio:mswc -- --language=en-GB --words=bed --download=all
```

The candidate report includes an `ipaCheck` field and the Markdown report shows the expected IPA versus nearby Wiktionary IPA claims when available.

Review downloaded candidates:

```bash
bun run audio:review
bun run audio:review -- --source=mswc --language=en-GB
```

Apply approved candidates:

```bash
bun run audio:apply-reviewed
bun run audio:apply-reviewed -- --source=mswc --language=en-GB
```

For British English, pass `--language=en-GB` to any audio command.

The reviewer updates the language-specific candidate report, each candidate metadata sidecar when present, and the language-specific review-state file. The scraper reads that review-state file on later runs and skips downloading candidates already approved or rejected. Use `--force-download-reviewed` if you intentionally want to download or stage them again. MSWC/Common Voice joins use clip filename stems only and do not write Common Voice client IDs into reports, sidecars, or app audio metadata.

The app supports multiple recordings per word. Each training round randomly locks one recording per word, so repeated plays in the same round use the same audio; the next round can choose a different recording.
