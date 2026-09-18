import z from 'zod'
import * as Sentry from '@sentry/node'
import { FieldValue } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, UpstreamError } from '../errors'
import { VideoHost, VideoType, VideoUploadStatus } from '../generated/graphql'
import { MUX_UPLOAD_CORS_ORIGIN } from '../config'
import { mux } from '../services/mux'
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

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })
      // adding a video that's already there is a no-op rather than an error
      if (trick.videos.some(v => v.host === VideoHost.YouTube && v.videoId === videoId)) return trick

      return await (dataSources.tricks.updateOnePartial(trickId, {
        videos: FieldValue.arrayUnion(video) as any as TrickDoc['videos'],
        updatedBy: user.id
      }) as Promise<TrickDoc>)
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
        cors_origin: isAllowedOrigin(origin) ? origin : MUX_UPLOAD_CORS_ORIGIN,
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
        const idx = videos.findIndex(v => v.videoId === videoId)
        if (idx === -1) return undefined

        t.update(ref.withConverter(null), { videos: videos.toSpliced(idx, 1), updatedBy: user.id })
        return videos[idx]
      })

      // the trick no longer references the asset either way, so a failed
      // deletion leaves an orphan in Mux rather than failing the mutation
      if (removed?.host === VideoHost.Mux) {
        try {
          await mux.video.assets.delete(removed.assetId)
        } catch (err) {
          logger.error(err, `Failed to delete the Mux asset ${removed.assetId}`)
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
