import { FieldValue, GrpcStatus, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { TrickSubmissionStatus, VideoType } from '../generated/graphql.js'
import { createTrickWithLocalisation, submissionAttribution, submitterProfile } from '../helpers/tricks.js'
import { createVideoUpload, tryDeleteAsset } from '../services/mux.js'
import { assertWithinSubmissionLimits, isTrustedSubmitter } from '../services/submissionLimits.js'
import { firestore } from '../store/firestoreDataSource.js'
import { rejectedSubmissionExpiry } from '../store/schema.js'
import { acceptTrickSubmissionSchema, reviewNoteSchema, trickSubmissionSchema } from '../validation.js'

import type { DocumentReference, Precondition, UpdateData } from 'firebase-admin/firestore'
import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { NewTrickLocalisation } from '../helpers/tricks.js'
import type { TrickVideoUploadWithUrl } from '../services/mux.js'
import type { TrickSubmissionDoc } from '../store/schema.js'

type Context = Pick<ApolloContext, 'dataSources'>

/** A submission answered with its once-only upload URL, see `TrickVideoUploadWithUrl` */
interface TrickSubmissionWithUpload extends TrickSubmissionDoc {
  upload: TrickVideoUploadWithUrl
}

/** A `WriteBatch` or a `Transaction`, either of which takes the writes of a review */
interface ReviewWriter {
  update: (ref: DocumentReference<any>, data: any, precondition?: Precondition) => unknown
}

async function existingSubmission (submissionId: string, { dataSources }: Context) {
  const submission = await dataSources.trickSubmissions.findOneById(submissionId)
  if (!submission) throw new NotFoundError(`Trick submission ${submissionId} not found`, { extensions: { entity: 'trick-submission', id: submissionId } })
  return submission
}

/** A submission still open to a review, read fresh so a review can be held to its version */
async function pendingSubmission (submissionId: string, context: Context) {
  const submission = await existingSubmission(submissionId, context)
  if (submission.status !== TrickSubmissionStatus.Pending) {
    throw new ValidationError('That submission has already been reviewed')
  }
  return submission
}

/**
 * Queues the review onto the submission and onto the submitter's counters. The
 * submission is only written if it has not changed since it was read, so two
 * editors reviewing at once cannot both count.
 */
function queueReview (
  submission: TrickSubmissionDoc,
  review: UpdateData<TrickSubmissionDoc>,
  counter: 'accepted' | 'rejected',
  writer: ReviewWriter,
  { dataSources }: Context
) {
  writer.update(dataSources.trickSubmissions.collection.doc(submission.id), review, { lastUpdateTime: submission.updatedAt })
  writer.update(dataSources.users.collection.doc(submission.userId), { [`submissionStats.${counter}`]: FieldValue.increment(1) })
}

/** Runs the writes of a review, a lost race reading as a submission already reviewed */
async function commitReview<T> (write: () => Promise<T>) {
  try {
    return await write()
  } catch (err) {
    if ((err as { code?: unknown }).code === GrpcStatus.FAILED_PRECONDITION) {
      throw new ValidationError('That submission has already been reviewed')
    }
    throw err
  }
}

/** The submission as the review left it, those writes having bypassed the data source caches */
async function reviewedSubmission (submission: TrickSubmissionDoc, context: Context) {
  const { dataSources } = context

  await Promise.all([
    dataSources.trickSubmissions.deleteFromCacheById(submission.id),
    dataSources.users.deleteFromCacheById(submission.userId)
  ])

  return await existingSubmission(submission.id, context)
}

export const trickSubmissionResolvers: Resolvers = {
  Query: {
    async trickSubmissions (_, { status }, { dataSources, allowUser }) {
      allowUser.reviewTrickSubmissions.assert()
      return await dataSources.trickSubmissions.findManyByStatus(status)
    }
  },
  Mutation: {
    async createTrickSubmission (_, { data }, { dataSources, allowUser, user, req }) {
      allowUser.createTrickSubmission.assert()
      if (!user) throw new AuthorizationError()
      const parsed = trickSubmissionSchema.parse(data)

      // the text becomes a localisation of the trick, which only exists in a
      // language the Tricktionary knows
      const lang = parsed.lang ?? user.lang ?? 'en'
      const language = await dataSources.languages.findOneById(lang, { ttl: 3600 })
      if (!language) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })

      const trusted = isTrustedSubmitter(user)
      await assertWithinSubmissionLimits(user.id, trusted, { dataSources })

      // the upload names the submission it belongs to, so its ID is minted first
      const submissionId = dataSources.trickSubmissions.collection.doc().id
      const upload = await createVideoUpload({
        owner: { submissionId },
        userId: user.id,
        type: VideoType.SlowMo,
        origin: req.get('origin')
      }, { dataSources })

      const now = Timestamp.now()
      const submission = await (dataSources.trickSubmissions.createOne({
        id: submissionId,
        userId: user.id,
        trusted,
        attributionName: parsed.attributionName,
        licenceAcceptedAt: now,
        submittedAt: now,
        discipline: parsed.discipline,
        ...(parsed.trickType != null ? { trickType: parsed.trickType } : {}),
        lang,
        name: parsed.name,
        ...(parsed.alternativeNames?.length ? { alternativeNames: parsed.alternativeNames } : {}),
        ...(parsed.description ? { description: parsed.description } : {}),
        status: TrickSubmissionStatus.Pending,
        uploadId: upload.id
      }) as Promise<TrickSubmissionDoc>)

      const withUpload: TrickSubmissionWithUpload = { ...submission, upload }
      return withUpload
    },
    async acceptTrickSubmission (_, { submissionId, data }, { dataSources, allowUser, user, logger }) {
      allowUser.reviewTrickSubmissions.assert()
      if (!user) throw new AuthorizationError()
      const parsed = acceptTrickSubmissionSchema.parse(data)

      const submission = await pendingSubmission(submissionId, { dataSources })
      const video = submission.video
      if (!video) throw new ValidationError('The video of that submission has not finished processing yet')

      const attribution = submissionAttribution(submission)
      const submittedInEnglish = submission.lang === 'en'
      // the submitter's own text, which is a localisation of its own only when
      // they did not write it in english
      const ownText: NewTrickLocalisation = {
        name: submission.name,
        alternativeNames: submission.alternativeNames,
        description: submission.description ?? '',
        submittedBy: submission.userId,
        attribution
      }
      const review: UpdateData<TrickSubmissionDoc> = {
        status: TrickSubmissionStatus.Accepted,
        reviewedBy: user.id,
        reviewedAt: Timestamp.now()
      }

      // the review is part of the transaction that creates the trick, so
      // neither can happen without the other
      await commitReview(async () => await createTrickWithLocalisation({
        discipline: parsed.discipline,
        trickType: parsed.trickType,
        slug: parsed.slug,
        localisation: submittedInEnglish
          ? { ...parsed.localisation, submittedBy: submission.userId, attribution }
          : { ...parsed.localisation, submittedBy: user.id },
        ...(submittedInEnglish ? {} : { translation: { ...ownText, lang: submission.lang } }),
        videos: [{
          ...video,
          type: parsed.videoType,
          ...(parsed.slowMoStart != null ? { slowMoStart: parsed.slowMoStart } : {})
        }],
        submittedBy: submission.userId,
        updatedBy: user.id,
        alsoWrite: (t, trickId) => { queueReview(submission, { ...review, trickId }, 'accepted', t, { dataSources }) }
      }, { dataSources, logger }))

      return await reviewedSubmission(submission, { dataSources })
    },
    async rejectTrickSubmission (_, { submissionId, note }, { dataSources, allowUser, user, logger }) {
      allowUser.reviewTrickSubmissions.assert()
      if (!user) throw new AuthorizationError()
      const reviewNote = note != null ? reviewNoteSchema.parse(note) : undefined

      const submission = await pendingSubmission(submissionId, { dataSources })

      const batch = firestore.batch()
      queueReview(submission, {
        status: TrickSubmissionStatus.Rejected,
        reviewedBy: user.id,
        reviewedAt: Timestamp.now(),
        expiresAt: rejectedSubmissionExpiry(),
        ...(reviewNote ? { reviewNote } : {})
      }, 'rejected', batch, { dataSources })
      await commitReview(async () => await batch.commit())

      // deleted once the rejection is recorded, so a lost race leaves the asset be
      if (submission.video) await tryDeleteAsset(submission.video.assetId, logger)

      return await reviewedSubmission(submission, { dataSources })
    }
  },
  TrickSubmission: {
    async submitter (submission, _, { dataSources }) {
      const user = await dataSources.users.findOneById(submission.userId, { ttl: 60 })
      if (!user) throw new NotFoundError(`User ${submission.userId} not found`, { extensions: { entity: 'user', id: submission.userId } })
      return submitterProfile(user)
    },
    async upload (submission, _, { dataSources }) {
      const carried = (submission as Partial<TrickSubmissionWithUpload>).upload
      if (carried) return carried

      const upload = await dataSources.trickVideoUploads.findOneById(submission.uploadId)
      if (!upload) throw new NotFoundError(`Trick video upload ${submission.uploadId} not found`, { extensions: { entity: 'trick-video-upload', id: submission.uploadId } })
      return upload
    },
    video (submission) {
      return submission.video ?? null
    },
    async trick (submission, _, { dataSources }) {
      if (submission.trickId == null) return null
      return await dataSources.tricks.findOneById(submission.trickId, { ttl: 3600 }) ?? null
    }
  },
  User: {
    async trickSubmissions (user, _, { dataSources, allowUser }) {
      if (!allowUser.user(user).getTrickSubmissions()) return []

      return await dataSources.trickSubmissions.findManyByUser(user.id)
    }
  }
}
