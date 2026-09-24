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

## API clients and scopes

Every request comes from an API client, identified by its key in the `Api-Key`
header, or anonymous without one. `Authorization` carries the signed in user's
Firebase ID token. `src/helpers/apiClientMiddleware.ts` identifies the client
before any route runs.

- **Built in:** `anonymous`, `web` and `admin`, in `src/services/apiClients.ts`
  with their origins in `src/helpers/cors.ts`.
- **Registered:** one `api-clients` document each. They may hold `public`,
  `site` and `profiles`; signing users in and the admin are for our own apps.

Keys identify a client rather than authenticate it: the apps ship theirs to
every browser. `api-keys` holds each key's SHA-256, never the key. Super
admins manage clients and issue and revoke keys on the admin's API clients
page, and changes take up to a minute to reach the API. The keys of `web` and
`admin` reach their builds as the `API_KEY` Actions variable, which the infra
repository sets. A new environment runs with `ACCESS_CONTROL=report` until
they have keys, as the admin needs its own to issue any.

| Scope | What | anonymous | web | admin |
|---|---|---|---|---|
| `public` | tricks and their tags, levels and videos, rulesets, languages | ✓ | ✓ | ✓ |
| `site` | interface messages, notices, event definitions, global stats, the shop | | ✓ | ✓ |
| `profiles` | users' public profiles, checklists and speed bests | | ✓ | |
| `account` | signing users in and acting as them | | ✓ | ✓ |
| `admin` | the admin | | | ✓ |

**`@requiresScopes(scopes: [[...]])`** takes any one of the lists, holding
every scope in it. On a type it applies to every field returning the type:
`User` needs `profiles`, `account` or `admin`, so a `public` client can't reach
users through `Trick.submitter`. Every query and mutation needs one; the API
won't start without, and `npm run schema:check` fails CI. Descriptions state
the requirements, as introspection doesn't show directives.

**Denied**, with the reason on the usage line:

- an operation selecting anything its client lacks the scopes for, as a whole
  and before anything runs: `INSUFFICIENT_SCOPE`, 403
- a key nobody holds: 401
- a browser origin the client may not call from: 403
- an `Authorization` header from a client without `account`: 403

Scopes limit clients; `src/services/permissions.ts` still decides what a user
may do.

**CORS** answers with the client's origins. A preflight carries no key, so it
gets every client's origins. `Origin` only binds browsers.

**`ACCESS_CONTROL=report`** logs what access control denies instead of
denying it. `enforce` is the default.

**Usage:** each request logs an `API usage` line, `jsonPayload.usage` holding
`client`, `kind` (`query`, `mutation` or `http`), `operation`, `target` (the
root fields, or the route), `status` and `denied`. The infra repository counts
them in the `api/usage` log-based metric.

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

Tricks carry tags from the `tags` collection, by tag ID. A tag is a flag, a
number (optionally bounded and stepped) or an enum with named values, and may be
limited to disciplines. Its slug is what searches call it, and tags may share a
slug as long as they share no discipline: `#slug` means the tag of the trick's
discipline. A slug can only be reused for disciplines no tag with it covers yet.
Tag wranglers define tags and their English names, translators translate them
and trick editors apply them. A change that would leave a tagged trick with a
value the tag no longer allows is refused.

A number or enum tag can be required: a trick of its disciplines is only
created, or has its tags or discipline changed, with it. Making a tag required
leaves the tricks without it as they are, the `missingRequiredTags` trick filter
finds them.

The seed creates a built in trick type tag per discipline, all with the slug
`trick-type`: required enum tags holding the trick type. Their values are data
like any enum tag's, the booklet orders and colours the types by them.
`npx tsx src/migrations/trick-type-tag.ts` moved the trick type there from the
tricks' former `trickType` field.

Search queries filter by tag with `#slug`, `#slug:value` or `#slug:>3`, and the
`tags` trick filter does the same without a query string, see the `tricks`
query. The API applies these filters itself, only the rest of the query goes to
Algolia.

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`. Records carry the names of the
trick's tags, a change to a tag's names reindexes the tricks carrying it.
The `tricktionary-api-algolia-api-key` secret needs write access to the indices.

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from Firestore
