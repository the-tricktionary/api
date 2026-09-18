import * as Sentry from '@sentry/node'
import { MUX_WEBHOOK_SECRET } from '../config'
import { VideoHost, VideoUploadStatus } from '../generated/graphql'
import { mux } from './mux'
import { logger as baseLogger } from './logger'
import { createDataSources } from '../store/firestoreDataSource'

import type Mux from '@mux/mux-node'
import type { RequestHandler } from 'express'
import type Pino from 'pino'
import type { DataSources } from '../store/firestoreDataSource'
import type { MuxVideo, TrickVideoUploadDoc } from '../store/schema'

type MuxWebhookEvent = Mux.Webhooks.UnwrapWebhookEvent

interface MuxWebhookContext {
  dataSources: DataSources
  logger: Pino.Logger
}

/** Updates an upload document and drops it from the cache */
async function setUploadStatus (upload: TrickVideoUploadDoc, changes: Partial<TrickVideoUploadDoc>, { dataSources }: MuxWebhookContext) {
  await dataSources.trickVideoUploads.updateOnePartial(upload.id, changes)
  await dataSources.trickVideoUploads.deleteFromCacheById(upload.id)
}

/**
 * Adds the finished asset to the trick the upload was started for. Videos are
 * stored inline on the trick, so a transaction keeps concurrent uploads from
 * overwriting each other.
 */
async function addAssetToTrick (upload: TrickVideoUploadDoc, asset: { id: string, playbackId: string }, { dataSources, logger }: MuxWebhookContext) {
  const video: MuxVideo = {
    host: VideoHost.Mux,
    videoId: asset.playbackId,
    assetId: asset.id,
    type: upload.type,
    ...(upload.slowMoStart != null ? { slowMoStart: upload.slowMoStart } : {})
  }

  const collection = dataSources.tricks.collection
  await collection.firestore.runTransaction(async t => {
    const ref = collection.doc(upload.trickId)
    const trick = (await t.get(ref)).data()
    if (!trick) throw new Error(`Trick ${upload.trickId} of upload ${upload.id} does not exist`)

    const videos = trick.videos ?? []
    // Mux retries a webhook until we acknowledge it, so the asset may already
    // be on the trick
    if (videos.some(v => v.host === VideoHost.Mux && v.assetId === asset.id)) {
      logger.info({ trickId: upload.trickId, assetId: asset.id }, 'Mux asset is already on the trick')
      return
    }

    t.update(ref.withConverter(null), { videos: [...videos, video] })
  })
  await dataSources.tricks.deleteFromCacheById(upload.trickId)
}

/**
 * Applies a Mux event to the upload it belongs to. Events for uploads we don't
 * know about are ignored, they're for assets created outside of the API (the
 * migration script, the Mux dashboard, ...).
 */
export async function handleMuxWebhookEvent (event: MuxWebhookEvent, context: MuxWebhookContext) {
  const { dataSources, logger } = context

  switch (event.type) {
    case 'video.upload.asset_created': {
      const upload = await dataSources.trickVideoUploads.findOneById(event.data.id)
      if (!upload) {
        logger.info({ uploadId: event.data.id, type: event.type }, 'Ignoring a Mux event for an unknown upload')
        break
      }

      await setUploadStatus(upload, {
        status: VideoUploadStatus.Processing,
        ...(event.data.asset_id != null ? { assetId: event.data.asset_id } : {})
      }, context)
      break
    }
    case 'video.asset.ready': {
      const uploadId = event.data.upload_id
      if (uploadId == null) {
        logger.info({ assetId: event.data.id, type: event.type }, 'Ignoring a Mux asset that did not come from a direct upload')
        break
      }

      const upload = await dataSources.trickVideoUploads.findOneById(uploadId)
      if (!upload) {
        logger.info({ uploadId, type: event.type }, 'Ignoring a Mux event for an unknown upload')
        break
      }

      const playbackId = event.data.playback_ids?.find(p => p.policy === 'public')?.id
      if (playbackId == null) throw new Error(`Mux asset ${event.data.id} of upload ${upload.id} has no public playback ID`)

      await addAssetToTrick(upload, { id: event.data.id, playbackId }, context)
      await setUploadStatus(upload, { status: VideoUploadStatus.Ready, assetId: event.data.id }, context)
      logger.info({ uploadId, trickId: upload.trickId, assetId: event.data.id, playbackId }, 'Added a Mux video to a trick')
      break
    }
    case 'video.asset.errored': {
      const uploadId = event.data.upload_id
      if (uploadId == null) {
        logger.info({ assetId: event.data.id, type: event.type }, 'Ignoring a Mux asset that did not come from a direct upload')
        break
      }

      const upload = await dataSources.trickVideoUploads.findOneById(uploadId)
      if (!upload) {
        logger.info({ uploadId, type: event.type }, 'Ignoring a Mux event for an unknown upload')
        break
      }

      const errors = event.data.errors
      const error = [errors?.type, ...(errors?.messages ?? [])].filter(part => part != null && part !== '').join(': ')
      await setUploadStatus(upload, { status: VideoUploadStatus.Errored, error: error === '' ? 'Mux could not process the video' : error }, context)
      logger.warn({ uploadId, trickId: upload.trickId, assetId: event.data.id, error }, 'A Mux asset errored')
      break
    }
    case 'video.upload.cancelled': {
      const upload = await dataSources.trickVideoUploads.findOneById(event.data.id)
      if (!upload) {
        logger.info({ uploadId: event.data.id, type: event.type }, 'Ignoring a Mux event for an unknown upload')
        break
      }

      await setUploadStatus(upload, { status: VideoUploadStatus.Cancelled }, context)
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
    event = await mux.webhooks.unwrap(body, req.headers, MUX_WEBHOOK_SECRET)
  } catch (err) {
    logger.warn(err, 'Rejected a Mux webhook we could not verify')
    res.status(400).send('Invalid signature')
    return
  }

  try {
    await handleMuxWebhookEvent(event, { dataSources: createDataSources(), logger: logger.child({ event: event.id }) })
  } catch (err) {
    // Mux retries events we don't acknowledge, and a retry of an event we
    // can't handle at all is just noise, so failures are reported rather than
    // handed back to Mux
    logger.error(err, `Failed to handle the Mux event ${event.type}`)
    Sentry.captureException(err)
  }

  res.status(200).send()
}
