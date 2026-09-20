import z from 'zod'
import * as Sentry from '@sentry/node'
import { FieldValue } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, UpstreamError } from '../errors.js'
import { VideoHost, VideoType, VideoUploadStatus } from '../generated/graphql.js'
import { MUX_UPLOAD_CORS_ORIGIN } from '../config.js'
import { mux } from '../services/mux.js'
import { isAllowedOrigin } from '../helpers/cors.js'
import { slowMoStartSchema, youTubeVideoIdSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { TrickDoc, TrickVideoUploadDoc, YouTubeVideo } from '../store/schema.js'

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
interface TrickVideoUploadWithUrl extends TrickVideoUploadDoc {
  url: string
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
        videos: FieldValue.arrayUnion(video),
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

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      const idx = trick.videos.findIndex(v => v.videoId === videoId)
      if (idx === -1) return trick
      const removed = trick.videos[idx]

      const updated = await (dataSources.tricks.updateOnePartial(trickId, {
        videos: FieldValue.arrayRemove(removed),
        updatedBy: user.id
      }) as Promise<TrickDoc>)

      // the trick no longer references the asset either way, so a failed
      // deletion leaves an orphan in Mux rather than failing the mutation
      if (removed.host === VideoHost.Mux) {
        try {
          await mux.video.assets.delete(removed.assetId)
        } catch (err) {
          logger.error(err, `Failed to delete the Mux asset ${removed.assetId}`)
          Sentry.captureException(err)
        }
      }

      return updated
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
      return (upload as Partial<TrickVideoUploadWithUrl>).url ?? null
    }
  }
}
