# the Tricktionary API

## Configuration and secrets

Configuration comes from the environment, and a `.env` file in the project root
is loaded automatically; `src/config.ts` is the whole list. Secrets are not in
there — they live in Google Secret Manager and are read through `getSecret()`
in `src/services/secrets.ts`. Set `GSM_<secret-name>` in the environment, most
easily in `.env`, to override one locally; `.env.example` lists them. It has to
be `.env` rather than an exported variable if you start the API through an npm
script: the names contain hyphens, and npm drops variables whose names are not
valid shell identifiers from the environment it passes on.

## Seed

`npx tsx src/migrations/seed.ts [--dry-run]` creates the documents the API
cannot work without: the English language, the Tricktionary ruleset (primary
when no ruleset is) and the `trick-type` tag. Where they exist it puts back
what the code relies on and leaves the rest, and it fails on what an admin has
to decide, like several primary rulesets. Run it on a new database and after a
deploy that adds to it.

## Jobs

`src/jobs/` holds Cloud Run jobs that run from the API's image on Cloud Scheduler
triggers, both set up in the infra repository. Each runs through `runJob`, as a
trace of its own and, with `JOB_SCHEDULE` set, a Sentry cron monitor.

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

## Booklets (Typst)

The booklets (`src/routes/booklet.ts`) are typeset by [Typst](https://typst.app),
from Alpine's package in the image; for local development install Typst and
put it on the PATH, or point `TYPST_BIN` at it. The template is
`templates/booklet/main.typ`, it reads everything from a `data.json` that
`src/services/booklet.ts` assembles. The English labels come from the site's
`en.json` (fetched from `WEB_URL`, cached for an hour), the translations from
the `ui-messages` collection like the site's own, and a key neither has is
printed as is. The fonts in `templates/fonts` are the site's PT Sans, under the
OFL. The print layout's trick map is laid out by Graphviz (`@viz-js/viz`, its
WebAssembly build) and handed to the template as an SVG.

`npm run booklet:check` typesets the template against fixture data in every
layout, the QA workflow runs it in the API's image so a template or Typst
change fails there first. Set `BOOKLET_CHECK_OUT` to a directory to look at
the PDFs.

## Tags

Tricks carry tags from the `tags` collection, keyed by slug. A tag is a flag, a
number (optionally bounded and stepped) or an enum with named values, and may be
limited to disciplines. Tag wranglers define tags and their English names,
translators translate them and trick editors apply them. A change that would
leave a tagged trick with a value the tag no longer allows is refused.

The built in `trick-type` tag, from the seed, holds the trick type. Tricks
still carry the legacy `trickType` field too. After the seed,
`npx tsx src/migrations/trick-type-tag.ts` takes the tag's translations from the
site's messages and tags every trick, run the Algolia reindex after it.

Search queries filter by tag with `#tag`, `#tag:value` or `#tag:>3`, see the
`tricks` query. The API applies these filters itself, only the rest of the
query goes to Algolia.

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`. Records carry the names of the
trick's tags, a change to a tag's names reindexes the tricks carrying it.
The `tricktionary-api-algolia-api-key` secret needs write access to the indices.

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from Firestore
