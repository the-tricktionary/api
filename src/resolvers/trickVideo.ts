import z from 'zod'
import * as Sentry from '@sentry/node'
import { AuthorizationError, NotFoundError, UpstreamError } from '../errors'
import { VideoHost, VideoType, VideoUploadStatus } from '../generated/graphql'
import { DEFAULT_UPLOAD_CORS_ORIGIN, mux } from '../services/mux'
import { isAllowedOrigin } from '../services/cors'
import { slowMoStartSchema, youTubeVideoIdSchema } from '../validation'

import type { Resolvers } from '../generated/graphql'
import type { TrickDoc, TrickVideoUploadDoc, YouTubeVideo } from '../store/schema'
import type { DataSources } from '../store/firestoreDataSource'

const youTubeVideoSchema = z.object({
  videoId: youTubeVideoIdSchema,
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema
})

const videoUploadSchema = z.object({
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema
})

/**
 * Mux hands out the URL of a direct upload exactly once, so it's returned with
 * the upload it was created for rather than stored on the document.
 */
export interface TrickVideoUploadWithUrl extends TrickVideoUploadDoc {
  url: string
}

/** Re-reads a trick after a transaction changed it, bypassing the cache */
async function reloadTrick (trickId: string, dataSources: DataSources): Promise<TrickDoc> {
  await dataSources.tricks.deleteFromCacheById(trickId)
  const trick = await dataSources.tricks.findOneById(trickId)
  if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })
  return trick
}

export const trickVideoResolvers: Resolvers = {
  Mutation: {
    async addTrickVideo (_, { trickId, data }, { dataSources, allowUser, user }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()
      const { videoId, type, slowMoStart } = youTubeVideoSchema.parse(data)

      const video: YouTubeVideo = {
        host: VideoHost.YouTube,
        videoId,
        type,
        ...(slowMoStart != null ? { slowMoStart } : {})
      }

      const collection = dataSources.tricks.collection
      await collection.firestore.runTransaction(async t => {
        const ref = collection.doc(trickId)
        const trick = (await t.get(ref)).data()
        if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

        const videos = trick.videos ?? []
        // adding a video that's already there is a no-op rather than an error
        if (videos.some(v => v.host === VideoHost.YouTube && v.videoId === videoId)) return

        t.update(ref.withConverter(null), { videos: [...videos, video], updatedBy: user.id })
      })

      return await reloadTrick(trickId, dataSources)
    },
    async createTrickVideoUpload (_, { trickId, data }, { dataSources, allowUser, user, req }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()
      const { type, slowMoStart } = videoUploadSchema.parse(data)

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      // the signed upload URL only accepts a browser upload from the origin
      // it was created for, so it has to be the caller's own one
      const origin = req.get('origin')
      const upload = await mux.video.uploads.create({
        cors_origin: isAllowedOrigin(origin) ? origin : DEFAULT_UPLOAD_CORS_ORIGIN,
        new_asset_settings: {
          playback_policies: ['public'],
          video_quality: 'basic',
          passthrough: trickId
        }
      })
      if (!upload.url) throw new UpstreamError(`Mux did not return an upload URL for upload ${upload.id}`, { extensions: { upstream: 'mux' } })

      const uploadDoc = await (dataSources.trickVideoUploads.createOne({
        id: upload.id,
        trickId,
        userId: user.id,
        type,
        status: VideoUploadStatus.Waiting,
        ...(slowMoStart != null ? { slowMoStart } : {})
      }) as Promise<TrickVideoUploadDoc>)
      await dataSources.trickVideoUploads.deleteFromCacheById(upload.id)

      const withUrl: TrickVideoUploadWithUrl = { ...uploadDoc, url: upload.url }
      return withUrl
    },
    async removeTrickVideo (_, { trickId, videoId }, { dataSources, allowUser, user, logger }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()

      const collection = dataSources.tricks.collection
      const removed = await collection.firestore.runTransaction(async t => {
        const ref = collection.doc(trickId)
        const trick = (await t.get(ref)).data()
        if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

        const videos = trick.videos ?? []
        const remove = videos.filter(v => v.videoId === videoId)
        if (remove.length === 0) return remove

        t.update(ref.withConverter(null), { videos: videos.filter(v => v.videoId !== videoId), updatedBy: user.id })
        return remove
      })

      // the trick no longer references the asset either way, so a failed
      // deletion leaves an orphan in Mux rather than failing the mutation
      for (const video of removed) {
        if (video.host !== VideoHost.Mux) continue
        try {
          await mux.video.assets.delete(video.assetId)
        } catch (err) {
          logger.error(err, `Failed to delete the Mux asset ${video.assetId}`)
          Sentry.captureException(err)
        }
      }

      return await reloadTrick(trickId, dataSources)
    }
  },
  Trick: {
    async pendingVideoUploads (trick, _, { dataSources, allowUser }) {
      if (!allowUser.getTrickVideoUploads()) return []
      return await dataSources.trickVideoUploads.findPendingByTrick(trick.id)
    }
  },
  TrickVideoUpload: {
    url (upload) {
      return (upload as Partial<TrickVideoUploadWithUrl>).url ?? ''
    }
  }
}
