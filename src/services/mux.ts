import Mux from '@mux/mux-node'
import { readFile, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { MUX_TOKEN_ID, MUX_TOKEN_SECRET } from '../config'
import { logger as baseLogger } from './logger'

import type Pino from 'pino'

type Asset = Mux.Video.Asset
type Upload = Mux.Video.Upload

let client: Mux | undefined

export function getMuxClient () {
  if (client) return client
  if (!MUX_TOKEN_ID || !MUX_TOKEN_SECRET) {
    throw new Error('MUX_TOKEN_ID and MUX_TOKEN_SECRET must be set to use the Mux API')
  }
  client = new Mux({ tokenId: MUX_TOKEN_ID, tokenSecret: MUX_TOKEN_SECRET })
  return client
}

export interface UploadOptions {
  /** Free-form string (max 255 chars) stored on the asset, useful for tracing */
  passthrough?: string
  /** Human readable title, shown in the Mux dashboard, max 512 code points */
  title?: string
  /** Identifier linking the asset to our own data (e.g. the trick ID), max 128 code points */
  externalId?: string
  /**
   * Origin allowed to PUT to the upload URL. We upload from the server so this
   * is mostly cosmetic, but the API requires it.
   */
  corsOrigin?: string
  /** Seconds the signed upload URL stays valid */
  timeout?: number
  /** How often to poll Mux for status updates, in ms */
  pollInterval?: number
  logger?: Pino.Logger
}

export class MuxUploadError extends Error {
  constructor (message: string, readonly upload?: Upload, readonly asset?: Asset) {
    super(message)
    this.name = 'MuxUploadError'
  }
}

/**
 * Upload a local video file to Mux using a direct upload and wait until the
 * resulting asset is ready for playback.
 *
 * Assets are created with the free `basic` video quality level and a public
 * playback policy.
 *
 * @returns the ready asset, including its playback IDs
 */
export async function uploadFileToMux (filePath: string, {
  passthrough,
  title,
  externalId,
  corsOrigin = 'https://the-tricktionary.com',
  timeout = 3600,
  pollInterval = 5_000,
  logger = baseLogger
}: UploadOptions = {}): Promise<Asset> {
  const mux = getMuxClient()

  const fileStat = await stat(filePath)
  const upload = await mux.video.uploads.create({
    cors_origin: corsOrigin,
    timeout,
    new_asset_settings: {
      playback_policies: ['public'],
      video_quality: 'basic',
      ...(passthrough ? { passthrough } : {}),
      ...(title ?? externalId
        ? {
            meta: {
              ...(title ? { title } : {}),
              ...(externalId ? { external_id: externalId } : {})
            }
          }
        : {})
    }
  })
  logger.info({ uploadId: upload.id, bytes: fileStat.size }, 'Created Mux direct upload')

  if (!upload.url) throw new MuxUploadError('Mux did not return an upload URL', upload)

  // Videos on the Tricktionary are short clips so a single PUT is fine, no need
  // for resumable uploads
  const body = await readFile(filePath)
  const res = await fetch(upload.url, {
    method: 'PUT',
    body,
    headers: { 'content-type': 'video/mp4' }
  })
  if (!res.ok) {
    throw new MuxUploadError(`Uploading file to Mux failed with status ${res.status}: ${await res.text()}`, upload)
  }
  logger.info({ uploadId: upload.id }, 'Uploaded file to Mux, waiting for asset')

  const assetId = await waitForUploadAsset(upload.id, { pollInterval, logger })
  const asset = await waitForAssetReady(assetId, { pollInterval, logger })
  return asset
}

/**
 * Poll a direct upload until Mux has created an asset for it.
 * @returns the asset ID
 */
export async function waitForUploadAsset (uploadId: string, { pollInterval = 5_000, logger = baseLogger }: Pick<UploadOptions, 'pollInterval' | 'logger'> = {}) {
  const mux = getMuxClient()
  while (true) {
    const upload = await mux.video.uploads.retrieve(uploadId)
    logger.debug({ uploadId, status: upload.status }, 'Polled Mux upload')
    switch (upload.status) {
      case 'asset_created':
        if (!upload.asset_id) throw new MuxUploadError('Upload reports asset_created but has no asset_id', upload)
        return upload.asset_id
      case 'errored':
        throw new MuxUploadError(`Mux upload errored: ${upload.error?.type ?? 'unknown'}: ${upload.error?.message ?? ''}`, upload)
      case 'cancelled':
      case 'timed_out':
        throw new MuxUploadError(`Mux upload ${upload.status}`, upload)
      case 'waiting':
      default:
        await sleep(pollInterval)
    }
  }
}

/**
 * Poll an asset until it is ready for playback (or errored).
 */
export async function waitForAssetReady (assetId: string, { pollInterval = 5_000, logger = baseLogger }: Pick<UploadOptions, 'pollInterval' | 'logger'> = {}) {
  const mux = getMuxClient()
  while (true) {
    const asset = await mux.video.assets.retrieve(assetId)
    logger.debug({ assetId, status: asset.status }, 'Polled Mux asset')
    switch (asset.status) {
      case 'ready':
        return asset
      case 'errored':
        throw new MuxUploadError(`Mux asset errored: ${JSON.stringify(asset.errors ?? {})}`, undefined, asset)
      case 'preparing':
      default:
        await sleep(pollInterval)
    }
  }
}

/**
 * Get the public playback ID for an asset
 */
export function getPublicPlaybackId (asset: Asset) {
  const playbackId = asset.playback_ids?.find(p => p.policy === 'public')
  if (!playbackId) throw new MuxUploadError(`Asset ${asset.id} has no public playback ID`, undefined, asset)
  return playbackId.id
}
