import z from 'zod'
import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError } from '../errors.js'
import { VideoHost, VideoType } from '../generated/graphql.js'
import { attribution, toContributor } from '../helpers/tricks.js'
import { createVideoUpload, tryDeleteAsset } from '../services/mux.js'
import { attributionInputSchema, slowMoStartSchema, youTubeVideoIdSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { AttributionInput, Resolvers } from '../generated/graphql.js'
import type { TrickDoc, Video, YouTubeVideo } from '../store/schema.js'

const optionalAttributionSchema = attributionInputSchema.nullish()

const youTubeVideoSchema = z.object({
  videoId: youTubeVideoIdSchema,
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema,
  attribution: optionalAttributionSchema
})

const videoUploadSchema = z.object({
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema,
  attribution: optionalAttributionSchema
})

/** The credit to store, refused when it names an account that does not exist */
async function creditedAttribution (input: AttributionInput | null | undefined, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  if (!input) return undefined

  let credited
  if (input.usernameOrId != null) {
    credited = await dataSources.users.findOneByUsernameOrId(input.usernameOrId, { ttl: 60 })
    if (!credited) throw new NotFoundError(`No user matches ${input.usernameOrId}`, { extensions: { entity: 'user', id: input.usernameOrId } })
  }

  return attribution(input.name, Timestamp.now(), credited?.id)
}

export const trickVideoResolvers: Resolvers = {
  Mutation: {
    async addTrickVideo (_, { trickId, data }, { dataSources, allowUser, user }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()
      const { videoId, type, slowMoStart, attribution: input } = youTubeVideoSchema.parse(data)
      const attribution = await creditedAttribution(input, { dataSources })

      const video: YouTubeVideo = {
        host: VideoHost.YouTube,
        videoId,
        type,
        ...(slowMoStart != null ? { slowMoStart } : {}),
        ...(attribution ? { attribution } : {})
      }

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })
      // adding a video that's already there is a no-op rather than an error,
      // and leaves the credit it already has alone
      if (trick.videos.some(v => v.host === VideoHost.YouTube && v.videoId === videoId)) return trick

      return await (dataSources.tricks.updateOnePartial(trickId, {
        videos: FieldValue.arrayUnion(video),
        updatedBy: user.id
      }) as Promise<TrickDoc>)
    },
    async createTrickVideoUpload (_, { trickId, data }, { dataSources, allowUser, user, req }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()
      const { type, slowMoStart, attribution: input } = videoUploadSchema.parse(data)
      const attribution = await creditedAttribution(input, { dataSources })

      const trick = await dataSources.tricks.findOneById(trickId)
      if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

      return await createVideoUpload({
        owner: { trickId },
        userId: user.id,
        type,
        slowMoStart,
        attribution,
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
    },
    async setTrickVideoAttribution (_, { trickId, videoId, attribution: input }, { dataSources, allowUser, user }) {
      allowUser.editTrickVideos.assert()
      if (!user) throw new AuthorizationError()
      const attribution = await creditedAttribution(optionalAttributionSchema.parse(input), { dataSources })

      const collection = dataSources.tricks.collection
      const dRef = collection.doc(trickId)

      // the whole array is written back, so it has to be read and rebuilt in a
      // transaction for a concurrent change to another video not to be lost
      await collection.firestore.runTransaction(async t => {
        const trick = (await t.get(dRef)).data()
        if (!trick) throw new NotFoundError(`Trick ${trickId} not found`, { extensions: { entity: 'trick', id: trickId } })

        const current = trick.videos.find(video => video.videoId === videoId)
        if (!current) throw new NotFoundError(`Trick ${trickId} has no video ${videoId}`, { extensions: { entity: 'video', id: videoId } })

        // the key is dropped rather than set to undefined, which Firestore rejects
        const { attribution: previous, ...uncredited } = current
        // contributors are ordered by their date, so editing a credit keeps the
        // one the contribution already carries
        const credit = attribution && previous ? { ...attribution, at: previous.at } : attribution
        const videos: Video[] = trick.videos.map(video => video === current
          ? { ...uncredited, ...(credit ? { attribution: credit } : {}) }
          : video
        )

        t.update(dRef.withConverter(null), { videos, updatedBy: user.id })
      })

      // the transaction bypassed the data source cache
      await dataSources.tricks.deleteFromCacheById(trickId)

      return await (dataSources.tricks.findOneById(trickId) as Promise<TrickDoc>)
    }
  },
  Trick: {
    async pendingVideoUploads (trick, _, { dataSources, allowUser }) {
      if (!allowUser.getTrickVideoUploads()) return []
      return await dataSources.trickVideoUploads.findPendingByTrick(trick.id)
    }
  },
  TrickVideoUpload: {
    attribution (upload) {
      return upload.attribution ? toContributor(upload.attribution) : null
    }
  }
}
