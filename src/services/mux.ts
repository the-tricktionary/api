import Mux from '@mux/mux-node'
import * as Sentry from '@sentry/node'
import { getSecret } from './secrets.js'
import { VideoUploadStatus } from '../generated/graphql.js'
import { MUX_UPLOAD_CORS_ORIGIN } from '../config.js'
import { UpstreamError } from '../errors.js'
import { isAllowedOrigin } from '../helpers/cors.js'

import type Pino from 'pino'
import type { VideoType } from '../generated/graphql.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { Attribution, TrickDoc, TrickSubmissionDoc, TrickVideoUploadDoc, UserDoc } from '../store/schema.js'

const [tokenId, tokenSecret] = await Promise.all([getSecret('tricktionary-api-mux-token-id'), getSecret('tricktionary-api-mux-token-secret')])

export const mux = new Mux({ tokenId, tokenSecret })

export const FINAL_UPLOAD_STATUSES = [VideoUploadStatus.Ready, VideoUploadStatus.Errored, VideoUploadStatus.Cancelled]

/**
 * Mux hands out the URL of a direct upload exactly once, so it's returned with
 * the upload it was created for rather than stored on the document.
 */
export interface TrickVideoUploadWithUrl extends TrickVideoUploadDoc {
  url: string
}

/** What the video belongs to, a trick or a submission waiting for review */
export type VideoUploadOwner = { trickId: TrickDoc['id'] } | { submissionId: TrickSubmissionDoc['id'] }

interface NewVideoUpload {
  owner: VideoUploadOwner
  userId: UserDoc['id']
  type: VideoType
  slowMoStart?: number | null
  /** Who to credit the video to once it is ready */
  attribution?: Attribution
  /** The origin of the request the upload is created for */
  origin?: string
}

/** Starts a direct upload to Mux, the asset reaches its owner through the webhook */
export async function createVideoUpload ({ owner, userId, type, slowMoStart, attribution, origin }: NewVideoUpload, { dataSources }: { dataSources: DataSources }) {
  // the signed upload URL only accepts a browser upload from the origin it was
  // created for, so it has to be the caller's own one
  const upload = await mux.video.uploads.create({
    cors_origin: isAllowedOrigin(origin) ? origin : MUX_UPLOAD_CORS_ORIGIN,
    new_asset_settings: {
      playback_policies: ['public'],
      video_quality: 'basic',
      passthrough: 'trickId' in owner ? owner.trickId : owner.submissionId
    }
  })
  if (!upload.url) throw new UpstreamError(`Mux did not return an upload URL for upload ${upload.id}`, { extensions: { upstream: 'mux' } })

  const uploadDoc = await (dataSources.trickVideoUploads.createOne({
    id: upload.id,
    ...owner,
    userId,
    type,
    status: VideoUploadStatus.Waiting,
    ...(slowMoStart != null ? { slowMoStart } : {}),
    ...(attribution ? { attribution } : {})
  }) as Promise<TrickVideoUploadDoc>)

  const withUrl: TrickVideoUploadWithUrl = { ...uploadDoc, url: upload.url }
  return withUrl
}

/**
 * Deletes an asset nothing refers to any more. A failed deletion leaves an
 * orphan in Mux rather than failing the caller.
 */
export async function tryDeleteAsset (assetId: string, logger: Pino.Logger) {
  try {
    await mux.video.assets.delete(assetId)
  } catch (err) {
    logger.error(err, `Failed to delete the Mux asset ${assetId}`)
    Sentry.captureException(err)
  }
}
