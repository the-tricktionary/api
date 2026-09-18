# the Tricktionary API

## Configuration and secrets

Configuration comes from the environment, and a `.env` file in the project root
is loaded automatically; `src/config.ts` is the whole list. Secrets are not in
there — they live in Google Secret Manager and are read through `getSecret()`
in `src/services/secrets.ts`. Set `GSM_<secret-name>` in the environment, most
easily in `.env`, to override one locally; `.env.example` lists them.

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

Mux needs the `tricktionary-api-mux-token-id`,
`tricktionary-api-mux-token-secret` and `tricktionary-api-mux-webhook-secret`
secrets.

### Migrating YouTube videos to Mux

`npx tsx src/migrations/mux-videos.ts` downloads every trick's YouTube videos with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), uploads them to Mux and adds them
as additional `Mux` videos on the trick. It is safe to re-run; tricks that
already have a Mux video of the same type are skipped.

Requirements: `yt-dlp` and `ffmpeg` on `PATH`, the
`tricktionary-api-mux-token-id` and `tricktionary-api-mux-token-secret`
secrets, and Firestore credentials with write access to the `tricks`
collection.

```sh
npx tsx src/migrations/mux-videos.ts --dry-run          # only list what would be migrated
npx tsx src/migrations/mux-videos.ts --trick <trickId>  # migrate a single trick
npx tsx src/migrations/mux-videos.ts --limit 5          # migrate at most 5 videos
```

## Speed event definitions and timing tracks

Speed scores refer to an event definition (`event-definitions`), which speed
editors (the `SpeedEditor` grant) manage from the admin interface. An event
definition can carry a timing track: the official audio of the event, with
cues for the start signal, athlete switches and the end signal. The web app
plays it while counting, and the cues split a relay's steps between athletes.

The audio lives in a Cloud Storage bucket, `TIMING_TRACK_BUCKET` in the
environment, that the API never reads or writes itself. It hands out V4 signed
upload URLs (`createTimingTrackUpload`) and stores the public URL of the
uploaded object on the event definition. The bucket needs:

- public reads, `allUsers` as Storage Object Viewer, so browsers can stream the audio
- a CORS rule that lets the admin app PUT to the signed URL:

```json
[{
  "origin": ["https://admin.the-tricktionary.com", "http://localhost:5173"],
  "method": ["PUT"],
  "responseHeader": ["Content-Type", "x-goog-content-length-range"],
  "maxAgeSeconds": 3600
}]
```

```sh
gcloud storage buckets update gs://tricktionary-timing-tracks --cors-file=cors.json
```

The service account the API runs as needs `roles/storage.objectAdmin` on the
bucket, and `roles/iam.serviceAccountTokenCreator` on itself so it can sign
URLs without a private key.

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`. The `tricktionary-api-algolia-api-key` secret
needs write access to the indices.

### Reindexing

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from
Firestore: it backfills `trickId` on trick localisations, applies the current
settings to every language index (creating the ones that don't exist yet) and
rewrites every record. Run it once after deploying, and again whenever the index
settings change. It never deletes anything from Algolia.

```sh
npx tsx src/migrations/algolia-reindex.ts --dry-run   # only log what would change
```
