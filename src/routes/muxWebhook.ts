import * as Sentry from '@sentry/node'
import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { TrickSubmissionStatus, VideoHost, VideoType, VideoUploadStatus } from '../generated/graphql.js'
import { submissionAttribution } from '../helpers/tricks.js'
import { mux, tryDeleteAsset } from '../services/mux.js'
import { getSecret } from '../services/secrets.js'
import { logger as baseLogger } from '../services/logger.js'
import { MAX_SUBMISSION_VIDEO_SECONDS } from '../services/submissionLimits.js'
import { createDataSources } from '../store/firestoreDataSource.js'
import { rejectedSubmissionExpiry } from '../store/schema.js'

import type Mux from '@mux/mux-node'
import type { RequestHandler } from 'express'
import type Pino from 'pino'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { MuxVideo, TrickDoc, TrickSubmissionDoc, TrickVideoUploadDoc } from '../store/schema.js'

type MuxWebhookEvent = Mux.Webhooks.UnwrapWebhookEvent

const webhookSecret = await getSecret('tricktionary-api-mux-webhook-secret')

/** How long a finished upload is kept before the collection's TTL policy deletes it */
const FINISHED_UPLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000

interface MuxWebhookContext {
  dataSources: DataSources
  logger: Pino.Logger
}

/**
 * Moves an upload to a final status. The TTL policy on `trick-video-uploads`
 * acts on `expiresAt`, so the two are set together rather than at each of the
 * call sites below.
 */
async function finishUpload (
  uploadId: string,
  update: Partial<TrickVideoUploadDoc> & Pick<TrickVideoUploadDoc, 'status'>,
  { dataSources }: MuxWebhookContext
) {
  await dataSources.trickVideoUploads.updateOnePartial(uploadId, {
    ...update,
    expiresAt: Timestamp.fromMillis(Date.now() + FINISHED_UPLOAD_TTL_MS)
  })
}

/**
 * The upload an event belongs to. Events for uploads we don't know about are
 * ignored, they're for assets created outside of the API (the migration
 * script, the Mux dashboard, ...).
 */
async function findUpload (uploadId: string | undefined, type: MuxWebhookEvent['type'], { dataSources, logger }: MuxWebhookContext) {
  if (uploadId == null) {
    logger.info({ type }, 'Ignoring a Mux asset that did not come from a direct upload')
    return undefined
  }
  const upload = await dataSources.trickVideoUploads.findOneById(uploadId)
  if (!upload) logger.info({ uploadId, type }, 'Ignoring a Mux event for an unknown upload')
  return upload
}

/** An asset Mux has finished processing */
interface ReadyAsset {
  id: string
  playbackId: string
  /** Seconds, absent when Mux did not report a duration */
  duration?: number
}

/** The parts of a stored video that the asset itself provides */
function videoOfAsset (asset: ReadyAsset): Pick<MuxVideo, 'host' | 'videoId' | 'assetId'> {
  return { host: VideoHost.Mux, videoId: asset.playbackId, assetId: asset.id }
}

async function addAssetToTrick (trickId: TrickDoc['id'], upload: TrickVideoUploadDoc, asset: ReadyAsset, context: MuxWebhookContext) {
  const { dataSources, logger } = context
  const video: MuxVideo = {
    ...videoOfAsset(asset),
    type: upload.type,
    ...(upload.slowMoStart != null ? { slowMoStart: upload.slowMoStart } : {})
  }

  const trick = await dataSources.tricks.findOneById(trickId)
  if (!trick) throw new Error(`Trick ${trickId} of upload ${upload.id} does not exist`)

  // Mux retries a webhook until we acknowledge it, so the asset may already
  // be on the trick
  if (trick.videos.some(v => v.host === VideoHost.Mux && v.assetId === asset.id)) {
    logger.info({ trickId, assetId: asset.id }, 'Mux asset is already on the trick')
  } else {
    await dataSources.tricks.updateOnePartial(trickId, { videos: FieldValue.arrayUnion(video) })
  }

  await finishUpload(upload.id, { status: VideoUploadStatus.Ready, assetId: asset.id }, context)
  logger.info({ uploadId: upload.id, trickId, assetId: asset.id, playbackId: asset.playbackId }, 'Added a Mux video to a trick')
}

/**
 * Puts the asset on the submission it was uploaded for. An asset no submission
 * waits for is deleted, as is one that runs longer than a submitted video may:
 * such a submission never reaches an editor, so the submitter's counters are
 * left alone.
 */
async function addAssetToSubmission (submissionId: TrickSubmissionDoc['id'], upload: TrickVideoUploadDoc, asset: ReadyAsset, context: MuxWebhookContext) {
  const { dataSources, logger } = context

  const submission = await dataSources.trickSubmissions.findOneById(submissionId)

  if (!submission) {
    const reason = 'The submission the video was uploaded for does not exist'
    await tryDeleteAsset(asset.id, logger)
    await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: reason }, context)
    logger.warn({ uploadId: upload.id, submissionId, assetId: asset.id }, 'Deleted a Mux asset whose trick submission does not exist')
    return
  }

  if (submission.status !== TrickSubmissionStatus.Pending) {
    const reason = 'The submission was rejected before the video was ready'
    await tryDeleteAsset(asset.id, logger)
    await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: reason }, context)
    logger.warn({ uploadId: upload.id, submissionId, assetId: asset.id, status: submission.status }, 'Deleted the Mux asset of a trick submission that was already reviewed')
    return
  }

  if (asset.duration != null && asset.duration > MAX_SUBMISSION_VIDEO_SECONDS) {
    const reason = `The video is longer than the ${MAX_SUBMISSION_VIDEO_SECONDS} seconds a submitted trick video may run for`
    await tryDeleteAsset(asset.id, logger)
    await dataSources.trickSubmissions.updateOnePartial(submissionId, {
      status: TrickSubmissionStatus.Rejected,
      reviewNote: reason,
      expiresAt: rejectedSubmissionExpiry()
    })
    await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: reason }, context)
    logger.warn({ uploadId: upload.id, submissionId, assetId: asset.id, duration: asset.duration }, 'Refused the video of a trick submission for being too long')
    return
  }

  const video: MuxVideo = {
    ...videoOfAsset(asset),
    // submitters upload one run at natural speed, the editor can still pick another type when they accept
    type: VideoType.FullSpeed,
    attribution: submissionAttribution(submission)
  }

  // Mux retries a webhook until we acknowledge it, so the asset may already
  // be on the submission
  if (submission.video?.assetId === asset.id) {
    logger.info({ submissionId, assetId: asset.id }, 'Mux asset is already on the trick submission')
  } else {
    await dataSources.trickSubmissions.updateOnePartial(submissionId, { video })
  }

  await finishUpload(upload.id, { status: VideoUploadStatus.Ready, assetId: asset.id }, context)
  logger.info({ uploadId: upload.id, submissionId, assetId: asset.id, playbackId: asset.playbackId }, 'Added a Mux video to a trick submission')
}

async function handleMuxWebhookEvent (event: MuxWebhookEvent, context: MuxWebhookContext) {
  const { dataSources, logger } = context

  switch (event.type) {
    case 'video.upload.asset_created': {
      const upload = await findUpload(event.data.id, event.type, context)
      // webhooks aren't delivered in order, a late asset_created must not
      // undo a status the asset events already set
      if (upload?.status !== VideoUploadStatus.Waiting) break

      await dataSources.trickVideoUploads.updateOnePartial(upload.id, {
        status: VideoUploadStatus.Processing,
        ...(event.data.asset_id != null ? { assetId: event.data.asset_id } : {})
      })
      break
    }
    case 'video.asset.ready': {
      const upload = await findUpload(event.data.upload_id, event.type, context)
      if (!upload) break

      const playbackId = event.data.playback_ids?.find(p => p.policy === 'public')?.id
      if (playbackId == null) throw new Error(`Mux asset ${event.data.id} of upload ${upload.id} has no public playback ID`)

      const asset = { id: event.data.id, playbackId, duration: event.data.duration }
      if (upload.submissionId != null) await addAssetToSubmission(upload.submissionId, upload, asset, context)
      else if (upload.trickId != null) await addAssetToTrick(upload.trickId, upload, asset, context)
      else throw new Error(`Upload ${upload.id} belongs to neither a trick nor a trick submission`)
      break
    }
    case 'video.asset.errored': {
      const upload = await findUpload(event.data.upload_id, event.type, context)
      if (!upload) break

      const errors = event.data.errors
      const error = [errors?.type, ...(errors?.messages ?? [])].filter(part => part != null && part !== '').join(': ')
      await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: error === '' ? 'Mux could not process the video' : error }, context)
      logger.warn({ uploadId: upload.id, trickId: upload.trickId, submissionId: upload.submissionId, assetId: event.data.id, error }, 'A Mux asset errored')
      break
    }
    case 'video.upload.errored': {
      const upload = await findUpload(event.data.id, event.type, context)
      if (!upload) break

      await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: 'The upload timed out or failed before Mux received the file' }, context)
      logger.warn({ uploadId: upload.id, trickId: upload.trickId, submissionId: upload.submissionId }, 'A Mux upload errored')
      break
    }
    case 'video.upload.cancelled': {
      const upload = await findUpload(event.data.id, event.type, context)
      if (!upload) break

      await finishUpload(upload.id, { status: VideoUploadStatus.Cancelled }, context)
      break
    }
    default:
      logger.debug({ type: event.type }, 'Ignoring a Mux event we do not handle')
  }
}

/**
 * `POST /webhooks/mux`, this is how a direct upload makes it onto the trick.
 * The handler runs outside of a GraphQL request, so it builds its own data
 * sources and never sees a user.
 *
 * The raw request body is needed to verify Mux's signature, so this has to be
 * mounted with `express.raw()` rather than the JSON body parser.
 */
export const muxWebhookHandler: RequestHandler = async (req, res) => {
  const logger = baseLogger.child({ name: 'mux-webhook' })
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : ''

  let event: MuxWebhookEvent
  try {
    event = await mux.webhooks.unwrap(body, req.headers, webhookSecret)
  } catch (err) {
    logger.warn(err, 'Rejected a Mux webhook we could not verify')
    res.status(400).send('Invalid signature')
    return
  }

  try {
    await handleMuxWebhookEvent(event, { dataSources: createDataSources(), logger: logger.child({ event: event.id }) })
  } catch (err) {
    // the handlers are idempotent, so a failure is handed back to Mux, which
    // retries the event with a backoff rather than losing the upload
    logger.error(err, `Failed to handle the Mux event ${event.type}`)
    Sentry.captureException(err)
    res.status(500).send()
    return
  }

  res.status(200).send()
}
