/**
 * Migration: re-host the YouTube videos of every trick on Mux.
 *
 * For every trick video with host `YouTube` that does not yet have a matching
 * (same `type`) `Mux` video, this script:
 *
 *   1. downloads the video from YouTube with yt-dlp (best mp4, video+audio)
 *   2. uploads the file to Mux with a direct upload
 *      (`basic` video quality, public playback policy)
 *   3. waits until the Mux asset is ready
 *   4. appends a `{ host: 'Mux', videoId: <playbackId>, assetId }` entry to the
 *      trick's `videos` array in Firestore, keeping the YouTube entry as-is
 *
 * The script is idempotent: tricks that already have a Mux video of the same
 * type are skipped, so it can be re-run after failures.
 *
 * Requirements:
 *   - `yt-dlp` and `ffmpeg` on PATH (ffmpeg is needed to merge video+audio)
 *   - the tricktionary-api-mux-token-id and tricktionary-api-mux-token-secret
 *     secrets, or GSM_<name> for each of them in the environment
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with
 *     write access to the `tricks` collection
 *
 * Usage:
 *   npx tsx src/migrations/mux-videos.ts [--dry-run] [--trick <id>] [--limit <n>] [--keep-files]
 *
 * Note: the API caches trick documents for up to an hour, so the new videos
 * show up in the API at most an hour after the migration ran.
 */
import '../config.js'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs, promisify } from 'node:util'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { VideoHost } from '../generated/graphql.js'
import { mux } from '../services/mux.js'
import { logger } from '../services/logger.js'

import type { MuxVideo, TrickDoc, TrickLocalisationDoc, YouTubeVideo } from '../store/schema.js'

const execFileAsync = promisify(execFile)

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    trick: { type: 'string' },
    limit: { type: 'string' },
    'keep-files': { type: 'boolean', default: false }
  }
})

const dryRun = args['dry-run']
const limit = args.limit ? parseInt(args.limit, 10) : Infinity
const keepFiles = args['keep-files']

const MUX_POLL_INTERVAL = 5_000

const firestore = new Firestore()

interface MigrationTarget {
  trickId: string
  trickName: string
  video: YouTubeVideo
}

/**
 * Download a YouTube video as an mp4 (video + audio merged) into `dir`.
 * @returns the path of the downloaded file
 */
async function downloadYouTubeVideo (youtubeId: string, dir: string) {
  const { stdout } = await execFileAsync('yt-dlp', [
    // best mp4 video + m4a audio, falling back to best pre-merged mp4, then anything
    '--format', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '--no-playlist',
    '--no-progress',
    '--quiet',
    '--no-simulate',
    // print the final path so we don't have to guess the extension
    '--print', 'after_move:filepath',
    '--output', join(dir, `${youtubeId}.%(ext)s`),
    '--',
    `https://www.youtube.com/watch?v=${youtubeId}`
  ], { maxBuffer: 10 * 1024 * 1024 })
  const filePath = stdout.trim().split('\n').pop()
  if (!filePath) throw new Error(`yt-dlp did not print a file path for ${youtubeId}`)
  return filePath
}

/**
 * Upload a local video file to Mux using a direct upload and wait until the
 * resulting asset is ready for playback.
 *
 * @returns the ready asset, including its playback IDs
 */
async function uploadFileToMux (filePath: string, { title, trickId, passthrough }: { title: string, trickId: string, passthrough: string }) {
  const upload = await mux.video.uploads.create({
    // required by the API even though we upload from a script rather than a browser
    cors_origin: 'https://the-tricktionary.com',
    timeout: 3600,
    new_asset_settings: {
      playback_policies: ['public'],
      video_quality: 'basic',
      passthrough,
      meta: { title, external_id: trickId }
    }
  })
  if (!upload.url) throw new Error(`Mux did not return an upload URL for upload ${upload.id}`)

  // Trick videos are short clips so a single PUT is fine, no need for
  // resumable uploads
  const res = await fetch(upload.url, {
    method: 'PUT',
    body: await readFile(filePath),
    headers: { 'content-type': 'video/mp4' }
  })
  if (!res.ok) throw new Error(`Uploading file to Mux failed with status ${res.status}: ${await res.text()}`)

  // wait for Mux to create the asset from the upload
  let assetId: string | undefined
  while (!assetId) {
    const status = await mux.video.uploads.retrieve(upload.id)
    switch (status.status) {
      case 'asset_created':
        assetId = status.asset_id
        break
      case 'errored':
        throw new Error(`Mux upload ${upload.id} errored: ${status.error?.type ?? 'unknown'}: ${status.error?.message ?? ''}`)
      case 'cancelled':
      case 'timed_out':
        throw new Error(`Mux upload ${upload.id} ${status.status}`)
      default:
        await sleep(MUX_POLL_INTERVAL)
    }
  }

  // wait for the asset to be ready for playback
  while (true) {
    const asset = await mux.video.assets.retrieve(assetId)
    switch (asset.status) {
      case 'ready':
        return asset
      case 'errored':
        throw new Error(`Mux asset ${assetId} errored: ${JSON.stringify(asset.errors ?? {})}`)
      default:
        await sleep(MUX_POLL_INTERVAL)
    }
  }
}

async function migrateVideo ({ trickId, trickName, video }: MigrationTarget, workDir: string) {
  const log = logger.child({ trickId, youtubeId: video.videoId, type: video.type })

  log.info('Downloading from YouTube')
  const filePath = await downloadYouTubeVideo(video.videoId, workDir)

  try {
    log.info({ filePath }, 'Uploading to Mux')
    const asset = await uploadFileToMux(filePath, {
      title: `${trickName} (${video.type})`,
      trickId,
      passthrough: JSON.stringify({ trickId, type: video.type, youtubeId: video.videoId })
    })

    const playbackId = asset.playback_ids?.find(p => p.policy === 'public')
    if (!playbackId) throw new Error(`Mux asset ${asset.id} has no public playback ID`)

    const muxVideo: MuxVideo = {
      host: VideoHost.Mux,
      videoId: playbackId.id,
      assetId: asset.id,
      type: video.type,
      ...(video.slowMoStart != null ? { slowMoStart: video.slowMoStart } : {})
    }
    log.info({ assetId: asset.id, playbackId: playbackId.id }, 'Mux asset ready')

    await firestore.runTransaction(async t => {
      const ref = firestore.collection('tricks').doc(trickId)
      const dSnap = await t.get(ref)
      const trick = dSnap.data() as TrickDoc | undefined
      if (!trick) throw new Error(`Trick ${trickId} disappeared during migration`)
      const videos = trick.videos ?? []
      // someone else might have added a Mux video in the meantime
      if (videos.some(v => v.host === VideoHost.Mux && v.type === video.type)) {
        log.warn('Trick already got a Mux video of this type while migrating, not adding another')
        return
      }
      t.update(ref, {
        videos: [...videos, muxVideo],
        updatedAt: Timestamp.now()
      })
    })
    log.info('Trick updated')
  } finally {
    if (!keepFiles) await rm(filePath, { force: true })
  }
}

async function main () {
  const localisations = new Map<string, TrickLocalisationDoc>()
  const lQSnap = await firestore.collection('trick-localisations').get()
  for (const dSnap of lQSnap.docs) localisations.set(dSnap.id, dSnap.data() as TrickLocalisationDoc)

  const tricksRef = firestore.collection('tricks')
  const tricks = args.trick
    ? [await tricksRef.doc(args.trick).get()].filter(d => d.exists)
    : (await tricksRef.get()).docs

  const targets: MigrationTarget[] = []
  let alreadyMigrated = 0
  for (const dSnap of tricks) {
    const trick = dSnap.data() as TrickDoc
    const videos = trick.videos ?? []
    for (const video of videos) {
      if (video.host !== VideoHost.YouTube) continue
      if (videos.some(v => v.host === VideoHost.Mux && v.type === video.type)) {
        alreadyMigrated++
        continue
      }
      targets.push({
        trickId: dSnap.id,
        trickName: localisations.get(`${dSnap.id}-en`)?.name ?? trick.slug,
        video
      })
    }
  }

  logger.info({ tricks: tricks.length, toMigrate: targets.length, alreadyMigrated, limit, dryRun }, 'Found videos to migrate')

  if (dryRun) {
    for (const target of targets.slice(0, limit)) {
      logger.info({ trickId: target.trickId, youtubeId: target.video.videoId, type: target.video.type }, `[dry-run] would migrate ${target.trickName}`)
    }
    return
  }

  const workDir = await mkdtemp(join(tmpdir(), 'tricktionary-mux-'))
  logger.info({ workDir }, 'Created work directory')

  const failed: Array<MigrationTarget & { error: unknown }> = []
  let done = 0
  try {
    for (const target of targets.slice(0, limit)) {
      try {
        await migrateVideo(target, workDir)
        done++
      } catch (error) {
        logger.error({ err: error, trickId: target.trickId, youtubeId: target.video.videoId }, 'Failed to migrate video')
        failed.push({ ...target, error })
      }
    }
  } finally {
    if (!keepFiles) await rm(workDir, { recursive: true, force: true })
  }

  logger.info({ done, failed: failed.length }, 'Migration finished')
  if (failed.length > 0) {
    for (const f of failed) {
      logger.warn({ trickId: f.trickId, youtubeId: f.video.videoId, type: f.video.type }, `Failed: ${f.trickName}`)
    }
    process.exitCode = 1
  }
}

main()
  .then(() => {
    process.exit()
  })
  .catch(err => {
    logger.fatal(err)
    process.exit(1)
  })
