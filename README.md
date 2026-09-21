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

`GET /booklets/tricks.pdf` typesets a printable list of a discipline's tricks.
The public site's Firebase Hosting config rewrites `/booklets/*.pdf` here, and
Hosting's CDN caches each combination of parameters for a day, so a booklet is
only typeset when nobody asked for that one lately.

| Parameter    | Values                | Default | |
| ------------ | --------------------- | ------- | - |
| `discipline` | `sr`, `dd`, `wh`      | required | |
| `paper`      | `a4`, `letter`        | `a4`    | |
| `lang`       | an enabled language   | `en`    | English fills in for anything not translated |
| `detailed`   | `1`, `0`              | `0`     | include the descriptions, names are always included |
| `rulesId`    | a ruleset             | none    | label each trick with its level in that ruleset, ✓ when verified |
| `layout`     | `pages`, `booklet`, `print` | `pages` | see below |
| `isbn`       | an ISBN-13            | none    | `print` only, shown in the colophon and as a barcode on the back |
| `printedBy`  | text                  | none    | `print` only, the printer named in the colophon |

`pages` typesets on the full sheet. `booklet` typesets half sheets and lays
them out two per side in saddle-stitch order: print double-sided, flipping on
the short edge, fold the stack down the middle and staple. Speed-log pages fill
the back, and as many more as it takes for the page count to come out at a
multiple of four.

`print` is for a print shop: half-sheet pages with a 3 mm bleed and a trim
box, the brand red cover with the logo, a colophon inside it, a trick map
spread at the back (every trick a dot coloured by type and sized by how many
tricks build on it, arrows from prerequisites, laid out by Graphviz through
the vendored `diagraph` package) and the ISBN barcode on the back cover. It
isn't imposed, print shops do that themselves. The site's form doesn't offer
it, it is only reached by URL.

The document is typeset by [Typst](https://typst.app), whose pinned release the
Dockerfile installs into the image (`TYPST_BIN` says where the binary is, for
local development install the same release and put it on the PATH). The
template is `templates/booklet/main.typ`, it reads everything from a
`data.json` that `src/services/booklet.ts` assembles: the tricks grouped by
Tricktionary level and type, and the labels. English labels come from the
site's `en.json` (fetched from `WEB_URL`, cached for an hour, with a copy of
the keys the booklet needs in `booklet.ts` as the fallback), translations from
the `ui-messages` collection like the site's own. The fonts in
`templates/fonts` are the site's PT Sans, under the OFL. Packages from Typst
Universe are vendored in `templates/packages` in the layout of Typst's package
cache, so nothing is downloaded while typesetting; to add or upgrade one, copy
its release into `preview/<name>/<version>` there.

`npm run booklet:check` typesets the template against fixture data in every
layout, the QA workflow runs it so a template or Typst change fails there
first. Set `BOOKLET_CHECK_OUT` to a directory to look at the PDFs.

## Search (Algolia)

Tricks are indexed once per language in `tricktionary_<lang>`, the index
settings live in `src/services/algolia.ts`.
The `tricktionary-api-algolia-api-key` secret needs write access to the indices.

`npx tsx src/migrations/algolia-reindex.ts` rebuilds every index from Firestore
