# the Tricktionary API

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
