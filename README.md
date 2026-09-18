# the Tricktionary API

## Data model

### Admin grants (`users`)

Administrative privileges live on the user document as an optional `grants`
array. Each grant is one of:

```ts
{ type: 'super-admin' }
{ type: 'trick-editor' }
{ type: 'translator', lang: string }          // BCP-47 tag, never 'en'
{ type: 'level-editor', rulesId: string, verificationLevel: VerificationLevel | null }
```

- `super-admin` implies every other grant, for every language and every ruleset.
- `trick-editor` may edit tricks and implies `translator` for `en` – english is
  the source language of the Tricktionary, so it's hard-coded rather than
  granted with a `translator` grant.
- `translator` may edit trick localisations in a single language.
- `level-editor` may edit trick levels for a single ruleset. Verification
  levels are ranked `null` (0) < `JUDGE` (1) < `OFFICIAL` (2), a grant with a
  `null` verification level may edit levels but not verify them.

Grants are exposed as `User.grants`, but only to the user themselves and to
super admins – for everyone else the field is an empty list.

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

### Migrating trick levels to rulesets

`npm run migrate:rulesets` creates the `rulesets` documents and rewrites the
old `organisation` + `rulesVersion` trick levels to the new shape and document
IDs. `organisation: 'tricktionary'` becomes `tricktionary`, `organisation:
'ijru'` becomes `ijru@<rulesVersion>` (defaulting to `ijru@2.0.0`), any other
organisation aborts the migration before anything is written. Levels that
already have a `rulesId` are skipped, so it is safe to re-run.

```sh
npm run migrate:rulesets -- --dry-run              # only log what would change
npm run migrate:rulesets -- --primary ijru@5.0.0   # pick the primary ruleset
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
