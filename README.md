# the Tricktionary API

## Trick levels

### Migrating trick levels to rulesets

`npx tsx src/migrations/rulesets.ts` creates the `rulesets` documents and rewrites the
old `organisation` + `rulesVersion` trick levels to the new shape and document
IDs. `organisation: 'tricktionary'` becomes `tricktionary`, `organisation:
'ijru'` becomes `ijru@<rulesVersion>` (defaulting to `ijru@2.0.0`), any other
organisation aborts the migration before anything is written. Levels that
already have a `rulesId` are skipped, so it is safe to re-run.

```sh
npx tsx src/migrations/rulesets.ts --dry-run              # only log what would change
npx tsx src/migrations/rulesets.ts --primary ijru@5.0.0   # pick the primary ruleset
```

Without `--primary` the newest IJRU ruleset becomes the primary one. The
primary ruleset is only set if no ruleset is primary yet.

## Videos

Trick videos are stored inline on the trick document as an array of
`{ host, videoId, type, slowMoStart? }`. Two hosts are supported:

- `YouTube` – `videoId` is the YouTube video ID
- `Mux` – `videoId` is the public [Mux](https://www.mux.com) playback ID, the
  Mux asset ID is stored alongside it as `assetId`

Mux needs `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` and `MUX_WEBHOOK_SECRET`.

### Migrating YouTube videos to Mux

`npx tsx src/migrations/mux-videos.ts` downloads every trick's YouTube videos with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), uploads them to Mux and adds them
as additional `Mux` videos on the trick. It is safe to re-run; tricks that
already have a Mux video of the same type are skipped.

Requirements: `yt-dlp` and `ffmpeg` on `PATH`, `MUX_TOKEN_ID` and
`MUX_TOKEN_SECRET` in the environment, and Firestore credentials with write
access to the `tricks` collection.

```sh
npx tsx src/migrations/mux-videos.ts --dry-run          # only list what would be migrated
npx tsx src/migrations/mux-videos.ts --trick <trickId>  # migrate a single trick
npx tsx src/migrations/mux-videos.ts --limit 5          # migrate at most 5 videos
```

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`. `ALGOLIA_API_KEY` needs write
access to the indices.

### Reindexing

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from
Firestore: it backfills `trickId` on trick localisations, applies the current
settings to every language index (creating the ones that don't exist yet) and
rewrites every record. Run it once after deploying, and again whenever the index
settings change. It never deletes anything from Algolia.

```sh
npx tsx src/migrations/algolia-reindex.ts --dry-run   # only log what would change
```
