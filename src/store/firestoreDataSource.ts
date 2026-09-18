import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { logger } from '../services/logger'
import { FINAL_UPLOAD_STATUSES } from '../services/mux'

import type { Discipline } from '../generated/graphql'
import type { TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc, TrickCompletionDoc, SpeedResultDoc, EventDefinitionDoc, RulesetDoc, TrickVideoUploadDoc } from './schema'
import type { CollectionReference, Query } from 'firebase-admin/firestore'
import type { FindArgs, QueryFindArgs } from 'apollo-datasource-firestore'
import type { Timestamp } from '@google-cloud/firestore'
import type { KeyValueCache } from '@apollo/utils.keyvaluecache'

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

export class TrickVideoUploadDataSource extends FirestoreDataSource<TrickVideoUploadDoc> {
  /** The uploads of a trick that haven't reached a final status yet */
  async findPendingByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('trickId', '==', trickId)
      .where('status', 'not-in', FINAL_UPLOAD_STATUSES), options)
  }
}
export const trickVideoUploadDataSource = (cache: KeyValueCache) => new TrickVideoUploadDataSource(firestore.collection('trick-video-uploads') as CollectionReference<TrickVideoUploadDoc>, { logger: logger.child({ name: 'trick-video-upload-data-source' }), cache })

export class RulesetDataSource extends FirestoreDataSource<RulesetDoc> {
  async findAll (options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c, options)
  }

  async findPrimary (options?: QueryFindArgs) {
    const result = await this.findManyByQuery(c => c.where('isPrimary', '==', true), options)
    return result[0]
  }
}
export const rulesetDataSource = (cache: KeyValueCache) => new RulesetDataSource(firestore.collection('rulesets') as CollectionReference<RulesetDoc>, { logger: logger.child({ name: 'ruleset-data-source' }), cache })

export class TrickLevelDataSource extends FirestoreDataSource<TrickLevelDoc> {
  async findManyByTrick ({ trickId, rulesId }: { trickId: string, rulesId?: string | null }, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q = c.where('trickId', '==', trickId)
      if (rulesId) q = q.where('rulesId', '==', rulesId)
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
export const trickPrerequisiteDataSource = (cache: KeyValueCache) => new TrickPrerequisiteDataSource(firestore.collection('trick-prerequisites') as CollectionReference<TrickPrereqDoc>, { logger: logger.child({ name: 'trick-prerequisite-data-source' }), cache })

export class UserDataSource extends FirestoreDataSource<UserDoc> {}
export const userDataSource = (cache: KeyValueCache) => new UserDataSource(firestore.collection('users') as CollectionReference<UserDoc>, { logger: logger.child({ name: 'user-data-source' }), cache })

export class TrickCompletionDataSource extends FirestoreDataSource<TrickCompletionDoc> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }
}
export const trickCompletionDataSource = (cache: KeyValueCache) => new TrickCompletionDataSource(firestore.collection('trick-completions') as CollectionReference<TrickCompletionDoc>, { logger: logger.child({ name: 'trick-completion-source' }), cache })

export class SpeedResultDataSource extends FirestoreDataSource<SpeedResultDoc> {
  async findManyByUser (userId: string, { ttl, limit, startAfter }: FindArgs & { limit?: number | null, startAfter?: Timestamp | null } = {}) {
    return await this.findManyByQuery(c => {
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

export interface DataSources {
  eventDefinitions: EventDefinitionDataSource
  rulesets: RulesetDataSource
  speedResults: SpeedResultDataSource
  tricks: TrickDataSource
  trickLocalisations: TrickLocalisationDataSource
  trickPrerequisites: TrickPrerequisiteDataSource
  trickLevels: TrickLevelDataSource
  trickCompletions: TrickCompletionDataSource
  trickVideoUploads: TrickVideoUploadDataSource
  users: UserDataSource
}

export const dataSourceCache = new InMemoryLRUCache()

export function createDataSources (cache: KeyValueCache = dataSourceCache): DataSources {
  return {
    eventDefinitions: eventDefinitionDataSource(cache),
    rulesets: rulesetDataSource(cache),
    speedResults: speedResultDataSource(cache),
    tricks: trickDataSource(cache),
    trickLocalisations: trickLocalisationDataSource(cache),
    trickPrerequisites: trickPrerequisiteDataSource(cache),
    trickLevels: trickLevelDataSource(cache),
    trickCompletions: trickCompletionDataSource(cache),
    trickVideoUploads: trickVideoUploadDataSource(cache),
    users: userDataSource(cache)
  }
}
