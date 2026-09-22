import { CollisionError } from '../errors.js'
import { tryIndexTrick } from '../services/algolia.js'
import { trickLocalisationId } from '../store/schema.js'

import type { Transaction } from 'firebase-admin/firestore'
import type { ApolloContext } from '../apollo.js'
import type { Timestamp } from '@google-cloud/firestore'
import type { Discipline, TrickType } from '../generated/graphql.js'
import type { Attribution, TrickDoc, TrickLocalisationDoc, TrickSubmissionDoc, UserDoc, Video } from '../store/schema.js'

type Context = Pick<ApolloContext, 'dataSources' | 'logger'>

/** The text of one localisation of a new trick, and who it came from */
export type NewTrickLocalisation = Pick<TrickLocalisationDoc, 'name' | 'alternativeNames' | 'description' | 'submittedBy' | 'attribution'>

export interface NewTrick {
  discipline: Discipline
  trickType: TrickType
  slug: string
  /** Every trick has an english localisation */
  localisation: NewTrickLocalisation
  /** A second localisation, in the language the trick was written in */
  translation?: NewTrickLocalisation & { lang: string }
  videos?: Video[]
  submittedBy: UserDoc['id']
  updatedBy: UserDoc['id']
  /**
   * Queued onto the transaction that creates the trick, for writes that have to
   * land with it or not at all.
   */
  alsoWrite?: (t: Transaction, trickId: TrickDoc['id']) => void
}

export async function createTrickWithLocalisation (trick: NewTrick, { dataSources, logger }: Context) {
  const collection = dataSources.tricks.collection
  const localisationCollection = dataSources.trickLocalisations.collection

  const localisations = [
    { lang: 'en', ...trick.localisation },
    ...(trick.translation ? [trick.translation] : [])
  ]

  // the slug is only unique within a discipline, and there's no way to
  // express that as a document ID, so a transaction guards it instead
  const trickId = await collection.firestore.runTransaction(async t => {
    const qSnap = await t.get(collection.where('discipline', '==', trick.discipline).where('slug', '==', trick.slug))
    if (!qSnap.empty) {
      throw new CollisionError(`A ${trick.discipline} trick with the slug ${trick.slug} already exists`, { extensions: { entity: 'trick', id: qSnap.docs[0]?.id } })
    }

    const dRef = collection.doc()
    t.create(dRef.withConverter(null), {
      slug: trick.slug,
      discipline: trick.discipline,
      trickType: trick.trickType,
      submittedBy: trick.submittedBy,
      updatedBy: trick.updatedBy,
      videos: trick.videos ?? []
    })
    for (const { lang, ...localisation } of localisations) {
      t.create(localisationCollection.doc(trickLocalisationId(dRef.id, lang)).withConverter(null), {
        trickId: dRef.id,
        name: localisation.name,
        alternativeNames: localisation.alternativeNames ?? [],
        description: localisation.description,
        submittedBy: localisation.submittedBy,
        updatedBy: trick.updatedBy,
        ...(localisation.attribution ? { attribution: localisation.attribution } : {})
      })
    }
    trick.alsoWrite?.(t, dRef.id)

    return dRef.id
  })

  const created = await (dataSources.tricks.findOneById(trickId) as Promise<TrickDoc>)

  await tryIndexTrick(trickId, { dataSources, logger })

  return created
}

/** A submitter as everybody gets to see them, nothing beyond what their profile shows */
export function submitterProfile (user: UserDoc): UserDoc {
  return {
    id: user.id,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    collection: user.collection,
    username: user.username,
    profile: user.profile,
    ...(user.profile.public
      ? {
          name: user.name,
          photo: user.photo
        }
      : {})
  }
}

/** A credit, without an account when none is known */
export function attribution (name: string, at: Timestamp, userId?: UserDoc['id']): Attribution {
  return { ...(userId != null ? { userId } : {}), name, at }
}

/** How a trick submission's contribution is credited, by the name the submitter chose */
export function submissionAttribution (submission: TrickSubmissionDoc): Attribution {
  return attribution(submission.attributionName, submission.submittedAt, submission.userId)
}

/** An `Attribution` as the schema's `Contributor` */
export function toContributor (attribution: Attribution) {
  return {
    userId: attribution.userId ?? null,
    name: attribution.name,
    contributedAt: attribution.at
  }
}

/**
 * Everyone credited on a trick, one entry per account, or per name for
 * contributors without one, at their earliest contribution and earliest first.
 */
export function mergeContributors (attributions: Array<Attribution | undefined>) {
  const earliest = new Map<string, Attribution>()
  for (const attribution of attributions) {
    if (!attribution) continue
    const key = attribution.userId != null ? `id:${attribution.userId}` : `name:${attribution.name}`
    const seen = earliest.get(key)
    if (!seen || attribution.at.toMillis() < seen.at.toMillis()) earliest.set(key, attribution)
  }

  return [...earliest.values()]
    .sort((a, b) => a.at.toMillis() - b.at.toMillis())
    .map(toContributor)
}
