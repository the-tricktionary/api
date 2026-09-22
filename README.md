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

## Admin digest (Mailjet)

A weekly email to everyone with a grant, with what is new for their grants:
pending trick submissions (trick editors, super admins), new tricks missing a
translation or level in their languages or rulesets (translators, level
editors), and changes to the site's `en.json` (translators, super admins).
It is opt-out, through `setNotificationOptions`.

`src/jobs/adminDigest.ts` runs as the Cloud Run job `tricktionary-admin-digest`
on a Cloud Scheduler trigger, both in the infra repository, and the deploy
workflow points the job at each new image. Its service account is the only one
that can read the Mailjet secrets. Jobs run through `src/jobs/runJob.ts`, as a
trace of their own and, when `JOB_SCHEDULE` is set, a Sentry cron monitor.

Each user's window runs from `notifications.adminDigestSentUntil` to midnight
UTC on the day of the run, and moves on whether or not anything was sent.
Tricks are found by `addedAt`, backfilled by `src/migrations/trick-added-at.ts`.

Mail goes out from `noreply@the-tricktionary.com`, with replies to
`contact@the-tricktionary.com`. With the domain's DMARC at `p=reject`, nothing
arrives unless Mailjet's DKIM record is in DNS.

`npx tsx src/jobs/adminDigest.ts --dry-run` logs the emails instead of sending
them and moves no windows.

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

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`.
The `tricktionary-api-algolia-api-key` secret needs write access to the indices.

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from Firestore
