import * as Sentry from '@sentry/node'
import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { VideoHost, VideoUploadStatus } from '../generated/graphql.js'
import { mux } from '../services/mux.js'
import { getSecret } from '../services/secrets.js'
import { logger as baseLogger } from '../services/logger.js'
import { createDataSources } from '../store/firestoreDataSource.js'

import type Mux from '@mux/mux-node'
import type { RequestHandler } from 'express'
import type Pino from 'pino'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { MuxVideo, TrickVideoUploadDoc } from '../store/schema.js'

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

async function addAssetToTrick (upload: TrickVideoUploadDoc, asset: { id: string, playbackId: string }, { dataSources, logger }: MuxWebhookContext) {
  const video: MuxVideo = {
    host: VideoHost.Mux,
    videoId: asset.playbackId,
    assetId: asset.id,
    type: upload.type,
    ...(upload.slowMoStart != null ? { slowMoStart: upload.slowMoStart } : {})
  }

  const trick = await dataSources.tricks.findOneById(upload.trickId)
  if (!trick) throw new Error(`Trick ${upload.trickId} of upload ${upload.id} does not exist`)

  // Mux retries a webhook until we acknowledge it, so the asset may already
  // be on the trick
  if (trick.videos.some(v => v.host === VideoHost.Mux && v.assetId === asset.id)) {
    logger.info({ trickId: upload.trickId, assetId: asset.id }, 'Mux asset is already on the trick')
    return
  }

  await dataSources.tricks.updateOnePartial(upload.trickId, { videos: FieldValue.arrayUnion(video) })
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

      await addAssetToTrick(upload, { id: event.data.id, playbackId }, context)
      await finishUpload(upload.id, { status: VideoUploadStatus.Ready, assetId: event.data.id }, context)
      logger.info({ uploadId: upload.id, trickId: upload.trickId, assetId: event.data.id, playbackId }, 'Added a Mux video to a trick')
      break
    }
    case 'video.asset.errored': {
      const upload = await findUpload(event.data.upload_id, event.type, context)
      if (!upload) break

      const errors = event.data.errors
      const error = [errors?.type, ...(errors?.messages ?? [])].filter(part => part != null && part !== '').join(': ')
      await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: error === '' ? 'Mux could not process the video' : error }, context)
      logger.warn({ uploadId: upload.id, trickId: upload.trickId, assetId: event.data.id, error }, 'A Mux asset errored')
      break
    }
    case 'video.upload.errored': {
      const upload = await findUpload(event.data.id, event.type, context)
      if (!upload) break

      await finishUpload(upload.id, { status: VideoUploadStatus.Errored, error: 'The upload timed out or failed before Mux received the file' }, context)
      logger.warn({ uploadId: upload.id, trickId: upload.trickId }, 'A Mux upload errored')
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
