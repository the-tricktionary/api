import z from 'zod'
import { FieldValue } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError } from '../errors.js'
import { VideoHost, VideoType } from '../generated/graphql.js'
import { createVideoUpload, tryDeleteAsset } from '../services/mux.js'
import { slowMoStartSchema, youTubeVideoIdSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { TrickDoc, YouTubeVideo } from '../store/schema.js'

const youTubeVideoSchema = z.object({
  videoId: youTubeVideoIdSchema,
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema
})

const videoUploadSchema = z.object({
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema
})

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

      return await createVideoUpload({
        owner: { trickId },
        userId: user.id,
        type,
        slowMoStart,
        origin: req.get('origin')
      }, { dataSources })
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

      if (removed.host === VideoHost.Mux) await tryDeleteAsset(removed.assetId, logger)

      return updated
    }
  },
  Trick: {
    async pendingVideoUploads (trick, _, { dataSources, allowUser }) {
      if (!allowUser.getTrickVideoUploads()) return []
      return await dataSources.trickVideoUploads.findPendingByTrick(trick.id)
    }
  }
}
