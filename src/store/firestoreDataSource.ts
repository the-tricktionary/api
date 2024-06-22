import { Firestore } from 'firebase-admin/firestore'
import { FindArgs, FirestoreDataSource } from 'apollo-datasource-firestore'
import { logger } from '../services/logger'

import type { Discipline } from '../generated/graphql'
import type { TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc, TrickCompletionDoc, SpeedResultDoc, EventDefinitionDoc } from './schema'
import type { CollectionReference, Query } from 'firebase-admin/firestore'
import type { QueryFindArgs } from 'apollo-datasource-firestore/dist/datasource'
import { Timestamp } from '@google-cloud/firestore'
import { KeyValueCache } from '@apollo/utils.keyvaluecache'

const firestore = new Firestore()

export class TrickDataSource extends FirestoreDataSource<TrickDoc> {
  async findManyByDiscipline (discipline?: Discipline | null, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q: Query<TrickDoc> = c
      if (discipline) q = q.where('discipline', '==', discipline)
      return q
    }, options)
  }

  async findOneBySlug ({ discipline, slug }: { discipline: Discipline, slug: string }, options?: QueryFindArgs) {
    const result = await this.findManyByQuery(c => c.where('discipline', '==', discipline).where('slug', '==', slug), options)
    return result[0]
  }
}
export const trickDataSource = (cache: KeyValueCache) => new TrickDataSource(firestore.collection('tricks') as CollectionReference<TrickDoc>, { logger: logger.child({ name: 'trick-data-source' }), cache })

export class TrickLocalisationDataSource extends FirestoreDataSource<TrickLocalisationDoc> {}
export const trickLocalisationDataSource = (cache: KeyValueCache) => new TrickLocalisationDataSource(firestore.collection('trick-localisations') as CollectionReference<TrickLocalisationDoc>, { logger: logger.child({ name: 'trick-localisation-data-source' }), cache })

export class TrickLevelDataSource extends FirestoreDataSource<TrickLevelDoc> {
  async findManyByFilters ({ trickId, organisation, rulesVersion }: { trickId: string, organisation?: string | null, rulesVersion?: string | null }, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q = c.where('trickId', '==', trickId)
      if (organisation) q = q.where('organisation', '==', organisation)
      if (rulesVersion) q = q.where('rulesVersion', '==', rulesVersion)
      return q
    }, options)
  }
}
export const trickLevelDataSource = (cache: KeyValueCache) => new TrickLevelDataSource(firestore.collection('trick-levels') as CollectionReference<TrickLevelDoc>, { logger: logger.child({ name: 'trick-level-data-source' }), cache })

export class TrickPrerequisiteDataSource extends FirestoreDataSource<TrickPrereqDoc> {
  async findManyPrerequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('parentId', '==', trickId), options)
  }

  async findManyRequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('childId', '==', trickId), options)
  }
}
export const trickPrerequisiteDataSource = (cache: KeyValueCache) =>  new TrickPrerequisiteDataSource(firestore.collection('trick-prerequisites') as CollectionReference<TrickPrereqDoc>, { logger: logger.child({ name: 'trick-prerequisite-data-source' }), cache })

export class UserDataSource extends FirestoreDataSource<UserDoc> {}
export const userDataSource = (cache: KeyValueCache) => new UserDataSource(firestore.collection('users') as CollectionReference<UserDoc>, { logger: logger.child({ name: 'user-data-source' }), cache })

export class TrickCompletionDataSource extends FirestoreDataSource<TrickCompletionDoc> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }
}
export const trickCompletionDataSource = (cache: KeyValueCache) => new TrickCompletionDataSource(firestore.collection('trick-completions') as CollectionReference<TrickCompletionDoc>, { logger: logger.child({ name: 'trick-completion-source' }), cache })

export class SpeedResultDataSource extends FirestoreDataSource<SpeedResultDoc> {
  async findManyByUser (userId: string, { ttl, limit, startAfter }: FindArgs & { limit?: number | null, startAfter?: Timestamp | null } = {}) {
    return this.findManyByQuery(c => {
      let q = c.where('userId', '==', userId).orderBy('createdAt', 'desc')
      if (startAfter) q = q.startAfter(startAfter)
      if (limit) q = q.limit(limit)
      return q
    }, { ttl })
  }
}
export const speedResultDataSource = (cache: KeyValueCache) => new SpeedResultDataSource(firestore.collection('speed-results') as CollectionReference<SpeedResultDoc>, { logger: logger.child({ name: 'speed-result-data-source' }), cache })

export class EventDefinitionDataSource extends FirestoreDataSource<EventDefinitionDoc> {
  async findOneByLookupCode (lookupCode: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c.where('lookupCode', '==', lookupCode), { ttl }))[0]
  }
}
export const eventDefinitionDataSource = (cache: KeyValueCache) => new EventDefinitionDataSource(firestore.collection('event-definitions') as CollectionReference<EventDefinitionDoc>, { logger: logger.child({ name: 'event-definition-data-source' }), cache })
