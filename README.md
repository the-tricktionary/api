# the Tricktionary API

## Data model

### Admin grants (`users`)

Administrative privileges live on the user document as an optional `grants`
array. Each grant is one of:

```ts
{ type: 'SuperAdmin' }
{ type: 'TrickEditor' }
{ type: 'Translator', lang: string }          // BCP-47 tag, never 'en'
{ type: 'LevelEditor', rulesId: string, verificationLevel: VerificationLevel | null }
```

- `SuperAdmin` implies every other grant, for every language and every ruleset.
- `TrickEditor` may edit tricks and implies `Translator` for `en` – english is
  the source language of the Tricktionary, so it's hard-coded rather than
  granted with a `Translator` grant.
- `Translator` may edit trick localisations in a single language.
- `LevelEditor` may edit trick levels for a single ruleset. Verification
  levels are ranked `null` (0) < `JUDGE` (1) < `OFFICIAL` (2), a grant with a
  `null` verification level may edit levels but not verify them.

Grants are exposed as `User.grants`, but only to the user themselves and to
super admins – for everyone else the field is an empty list.

### Trick mutations

Tricks, their localisations and their prerequisite edges are edited through
these mutations:

- `createTrick(data)` – creates the trick and its english localisation in one
  transaction. Super admins and trick editors.
- `updateTrickDetails(trickId, data)` – changes the discipline, trick type
  and/or slug, only the fields that are given change. Super admins and trick
  editors.
- `setTrickLocalisation(trickId, lang, data)` – creates or replaces the
  localisation `${trickId}-${lang}`. Super admins, trick editors (for `en`)
  and translators for that language.
- `addTrickPrerequisite(trickId, prerequisiteId)` /
  `removeTrickPrerequisite(trickId, prerequisiteId)` – add or remove an edge in
  `trick-prerequisites`, both return the parent trick. Super admins and trick
  editors.

A slug is unique per discipline, which Firestore can't express as a document
ID, so `createTrick` and a `updateTrickDetails` that moves a trick check it in
a transaction and fail with `ENTITY_COLLISION` if the slug is taken. Changing
the discipline of a trick that has prerequisites (in either direction) is
rejected – prerequisites only ever link tricks of the same discipline, so its
edges have to be removed first. Every one of these mutations reindexes the
trick in Algolia afterwards; a failure there is logged and reported to Sentry
but never fails the mutation.

### Rulesets (`rulesets`)

A ruleset is a set of rules levels are assigned under. The document ID is the
rules ID itself, which is a lowercase slug optionally followed by a version,
e.g. `tricktionary` or `ijru@5.0.0` (`/^[a-z0-9-]+(@[0-9]+(\.[0-9]+)*)?$/`).

- `names` – a map of BCP-47 language tag to display name, `en` is required and
  is the fallback for languages without a name
- `isPrimary` – exactly one ruleset is the primary one, `setPrimaryRuleset`
  moves the flag in a transaction

Only super admins may create, update or set the primary ruleset.

### Trick levels (`trick-levels`)

A trick has at most one level per ruleset, so the document ID is deterministic:
`${trickId}-${rulesId}`.

- `trickId`, `rulesId` – the trick and the ruleset the level belongs to
- `level` – a string, e.g. `"5"` or `"2-5"`
- `verificationLevel` – `null`, `JUDGE` or `OFFICIAL`, `null` means the level
  has been submitted but not verified
- `verifiedBy` / `verifiedAt` – who verified the level and when, `null` while
  the level is unverified
- `updatedBy` – who last edited the level

#### Level mutations

`setTrickLevel(trickId, rulesId, level)` creates or overwrites the level of a
trick under a ruleset, a `null` or empty `level` deletes it instead. A level is
a whole number or a range of whole numbers (`"5"`, `"2-5"`), the tricktionary's
own levels (`rulesId: "tricktionary"`) are a single number from 1 to 5. Editing
a level always resets its verification to the editor's own verification rank, so
a `JUDGE` verifier's edit stays verified at `JUDGE` while a level editor without
a verification level leaves the level unverified.

`setTrickLevelVerification(trickId, rulesId, verificationLevel)` verifies an
existing level, or recalls its verification when `verificationLevel` is `null`.

Verification levels are ranked: unverified (`null`) is 0, `JUDGE` is 1 and
`OFFICIAL` is 2. A user's rank for a ruleset is the highest `verificationLevel`
of their `LevelEditor` grants for it, super admins rank 2. Editing the levels of
a ruleset requires a `LevelEditor` grant for it, editing the tricktionary levels
requires `TrickEditor`. On top of that:

- overwriting or deleting a level requires the user's rank to be at least the
  level's current verification rank
- verifying at a rank `T` requires the user's rank to be at least `T` and `T` to
  be above the level's current rank, so verifications are only ever raised
- recalling a verification requires the level to be verified and the user's rank
  to be at least the level's current rank

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

**Breaking API change:** `Trick.levels(rulesId: String)` replaces
`Trick.levels(organisation: String, rulesVersion: String)`, and `TrickLevel`
exposes `rulesId`/`ruleset` instead of `organisation`/`rulesVersion`.

## Videos

Trick videos are stored inline on the trick document as an array of
`{ host, videoId, type, slowMoStart? }`. Two hosts are supported:

- `YouTube` – `videoId` is the YouTube video ID
- `Mux` – `videoId` is the public [Mux](https://www.mux.com) playback ID, the
  Mux asset ID is stored alongside it as `assetId`

### Migrating YouTube videos to Mux

`npm run migrate:mux-videos` downloads every trick's YouTube videos with
[yt-dlp](https://github.com/yt-dlp/yt-dlp), uploads them to Mux and adds them
as additional `Mux` videos on the trick. It is safe to re-run; tricks that
already have a Mux video of the same type are skipped.

Requirements: `yt-dlp` and `ffmpeg` on `PATH`, `MUX_TOKEN_ID` and
`MUX_TOKEN_SECRET` in the environment, and Firestore credentials with write
access to the `tricks` collection.

```sh
npm run migrate:mux-videos -- --dry-run          # only list what would be migrated
npm run migrate:mux-videos -- --trick <trickId>  # migrate a single trick
npm run migrate:mux-videos -- --limit 5          # migrate at most 5 videos
```

## Search (Algolia)

Tricks are searched through Algolia, with one index per language named
`tricktionary_<lang>`. `Query.tricks(searchQuery:)` searches the index of the
requesting user's language and falls back to `tricktionary_en` when that index
doesn't exist yet. A record is one trick in one language, keyed by the trick ID:

```jsonc
{
  "objectID": "...",
  "slug": "...",
  "discipline": "SingleRope",
  "trickType": "manipulation",
  "name": "...",                    // this language
  "alternativeNames": ["..."],
  "description": "...",
  "enName": "...",                  // omitted in tricktionary_en
  "enAlternativeNames": ["..."],
  "ttLevel": 1                      // the `tricktionary` level, omitted when there is none
}
```

The english names are duplicated into every other index so a trick can always
be found by its english name, and `ttLevel` is the custom ranking, so easier
tricks come first when the text relevance is a tie.

The index settings are managed by the API rather than the Algolia dashboard:
`ensureIndex(lang)` in `src/services/algolia.ts` applies them the first time
this process writes to a language index, which also creates indices for
languages that are new. Changing the settings there means re-running the
reindex script below (or waiting for every trick to be edited).

Two API keys are needed: `ALGOLIA_API_KEY` is a search-only key used by the
lite client, `ALGOLIA_WRITE_API_KEY` is used for `saveObjects`, `setSettings`
and `listIndices`. Both are read from the environment together with
`ALGOLIA_APP_ID`.

### Reindexing

`npx tsx src/migrations/algolia-reindex.ts` rebuilds the indices from
Firestore. It also backfills the `trickId` field on trick localisations, which
is what lets the API find a trick's localisations when it reindexes a single
trick, so it has to be run once before the trick mutations can keep the index
up to date for older tricks. It never deletes anything from Algolia.

```sh
npx tsx src/migrations/algolia-reindex.ts --dry-run   # only log what would change
```
