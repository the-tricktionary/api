# the Tricktionary API

## Configuration and secrets

Plain configuration is read from the environment, and a `.env` file in the
project root is loaded automatically. `src/config.ts` is the whole list:
`PORT`, `SENTRY_DSN`, `ALGOLIA_APP_ID`, `GCP_PROJECT`, `MUX_UPLOAD_CORS_ORIGIN`,
`GSM_LOCATION`. None of them are secret — a Sentry DSN and an Algolia app ID are
both handed out to browsers.

Secrets are read from [Google Secret Manager](https://cloud.google.com/secret-manager)
through `getSecret()` in `src/services/secrets.ts`, one Secret Manager secret
per value:

| Secret | Used for |
| --- | --- |
| `STRIPE_SK` | the Stripe API key the shop uses |
| `ALGOLIA_API_KEY` | writing to and searching the Algolia indices |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | the Mux API |
| `MUX_WEBHOOK_SECRET` | verifying the signature on `POST /webhooks/mux` |

The name is the Secret Manager secret ID, so `STRIPE_SK` is read from
`projects/<project>/secrets/STRIPE_SK/versions/latest`. The project is
`GCP_PROJECT`, falling back to the project of the application default
credentials and, on Cloud Run, to the metadata server. The service account
needs `roles/secretmanager.secretAccessor` on each secret:

```sh
printf %s "$VALUE" | gcloud secrets create STRIPE_SK --data-file=-
gcloud secrets add-iam-policy-binding STRIPE_SK \
  --member="serviceAccount:<the Cloud Run service account>" \
  --role="roles/secretmanager.secretAccessor"
```

Use global secrets, which are readable from every region — a region never
appears in a secret's name, and moving the service between regions needs no
change here. `GSM_LOCATION` switches to
[regional secrets](https://cloud.google.com/secret-manager/docs/locations),
which exist for data residency and are addressed through a regional endpoint.

### Overriding a secret locally

Setting `GSM_<name>` in the environment (or in `.env`) returns that value
instead of asking Secret Manager, so local development and the migration
scripts don't need access to the real secrets:

```sh
GSM_STRIPE_SK=sk_test_... npm run dev
```

If every secret is overridden this way, Secret Manager is never contacted at
all. Values are read while the modules that need them are loaded, so a secret
that can't be read stops the process from starting rather than failing the
first request that needs it. A resolved value is kept for the lifetime of the
process, so a rotated secret is picked up by a new instance rather than a
running one.

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

Mux needs the `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` and `MUX_WEBHOOK_SECRET`
secrets.

### Migrating YouTube videos to Mux

`npx tsx src/migrations/mux-videos.ts` downloads every trick's YouTube videos with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), uploads them to Mux and adds them
as additional `Mux` videos on the trick. It is safe to re-run; tricks that
already have a Mux video of the same type are skipped.

Requirements: `yt-dlp` and `ffmpeg` on `PATH`, the `MUX_TOKEN_ID` and
`MUX_TOKEN_SECRET` secrets, and Firestore credentials with write access to the
`tricks` collection.

```sh
npx tsx src/migrations/mux-videos.ts --dry-run          # only list what would be migrated
npx tsx src/migrations/mux-videos.ts --trick <trickId>  # migrate a single trick
npx tsx src/migrations/mux-videos.ts --limit 5          # migrate at most 5 videos
```

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`. The `ALGOLIA_API_KEY` secret needs write
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
