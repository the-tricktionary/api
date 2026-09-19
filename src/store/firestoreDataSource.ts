import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { logger } from '../services/logger.js'
import { FINAL_UPLOAD_STATUSES } from '../services/mux.js'

import type { Discipline } from '../generated/graphql.js'
import type { TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc, TrickCompletionDoc, SpeedResultDoc, EventDefinitionDoc, LanguageDoc, RulesetDoc, TrickVideoUploadDoc, UiMessagesDoc } from './schema.js'
import type { CollectionReference, DocumentData, Query } from 'firebase-admin/firestore'
import type { FindArgs, QueryFindArgs } from 'apollo-datasource-firestore'
import type { Timestamp } from '@google-cloud/firestore'
import type { KeyValueCache } from '@apollo/utils.keyvaluecache'

const firestore = new Firestore()

// the collection type is only ever what the document type says it is
function collection<T extends DocumentData> (name: string) {
  return firestore.collection(name) as CollectionReference<T>
}

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
export const trickDataSource = (cache: KeyValueCache) => new TrickDataSource(collection<TrickDoc>('tricks'), { logger: logger.child({ name: 'trick-data-source' }), cache })

export class TrickLocalisationDataSource extends FirestoreDataSource<TrickLocalisationDoc> {}
export const trickLocalisationDataSource = (cache: KeyValueCache) => new TrickLocalisationDataSource(collection<TrickLocalisationDoc>('trick-localisations'), { logger: logger.child({ name: 'trick-localisation-data-source' }), cache })

export class TrickVideoUploadDataSource extends FirestoreDataSource<TrickVideoUploadDoc> {
  async findPendingByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('trickId', '==', trickId)
      .where('status', 'not-in', FINAL_UPLOAD_STATUSES), options)
  }
}
export const trickVideoUploadDataSource = (cache: KeyValueCache) => new TrickVideoUploadDataSource(collection<TrickVideoUploadDoc>('trick-video-uploads'), { logger: logger.child({ name: 'trick-video-upload-data-source' }), cache })

export class LanguageDataSource extends FirestoreDataSource<LanguageDoc> {
  async findAll (options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c, options)
  }
}
export const languageDataSource = (cache: KeyValueCache) => new LanguageDataSource(collection<LanguageDoc>('languages'), { logger: logger.child({ name: 'language-data-source' }), cache })

export class UiMessagesDataSource extends FirestoreDataSource<UiMessagesDoc> {}
export const uiMessagesDataSource = (cache: KeyValueCache) => new UiMessagesDataSource(collection<UiMessagesDoc>('ui-messages'), { logger: logger.child({ name: 'ui-messages-data-source' }), cache })

export class RulesetDataSource extends FirestoreDataSource<RulesetDoc> {
  async findAll (options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c, options)
  }
}
export const rulesetDataSource = (cache: KeyValueCache) => new RulesetDataSource(collection<RulesetDoc>('rulesets'), { logger: logger.child({ name: 'ruleset-data-source' }), cache })

export class TrickLevelDataSource extends FirestoreDataSource<TrickLevelDoc> {
  async findManyByTrick ({ trickId, rulesId }: { trickId: string, rulesId?: string | null }, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q = c.where('trickId', '==', trickId)
      if (rulesId) q = q.where('rulesId', '==', rulesId)
      return q
    }, options)
  }

  async findManyByRuleset (rulesId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('rulesId', '==', rulesId), options)
  }
}
export const trickLevelDataSource = (cache: KeyValueCache) => new TrickLevelDataSource(collection<TrickLevelDoc>('trick-levels'), { logger: logger.child({ name: 'trick-level-data-source' }), cache })

export class TrickPrerequisiteDataSource extends FirestoreDataSource<TrickPrereqDoc> {
  async findManyPrerequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('parentId', '==', trickId), options)
  }

  async findManyRequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('childId', '==', trickId), options)
  }
}
export const trickPrerequisiteDataSource = (cache: KeyValueCache) => new TrickPrerequisiteDataSource(collection<TrickPrereqDoc>('trick-prerequisites'), { logger: logger.child({ name: 'trick-prerequisite-data-source' }), cache })

export class UserDataSource extends FirestoreDataSource<UserDoc> {
  async findManyWithGrants (options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('grants', '!=', []), options)
  }
}
export const userDataSource = (cache: KeyValueCache) => new UserDataSource(collection<UserDoc>('users'), { logger: logger.child({ name: 'user-data-source' }), cache })

export class TrickCompletionDataSource extends FirestoreDataSource<TrickCompletionDoc> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }
}
export const trickCompletionDataSource = (cache: KeyValueCache) => new TrickCompletionDataSource(collection<TrickCompletionDoc>('trick-completions'), { logger: logger.child({ name: 'trick-completion-source' }), cache })

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
export const speedResultDataSource = (cache: KeyValueCache) => new SpeedResultDataSource(collection<SpeedResultDoc>('speed-results'), { logger: logger.child({ name: 'speed-result-data-source' }), cache })

export class EventDefinitionDataSource extends FirestoreDataSource<EventDefinitionDoc> {
  async findOneByLookupCode (lookupCode: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c.where('lookupCode', '==', lookupCode), { ttl }))[0]
  }
}
export const eventDefinitionDataSource = (cache: KeyValueCache) => new EventDefinitionDataSource(collection<EventDefinitionDoc>('event-definitions'), { logger: logger.child({ name: 'event-definition-data-source' }), cache })

export const dataSourceCache = new InMemoryLRUCache()

export function createDataSources () {
  return {
    eventDefinitions: eventDefinitionDataSource(dataSourceCache),
    languages: languageDataSource(dataSourceCache),
    rulesets: rulesetDataSource(dataSourceCache),
    speedResults: speedResultDataSource(dataSourceCache),
    tricks: trickDataSource(dataSourceCache),
    trickLocalisations: trickLocalisationDataSource(dataSourceCache),
    trickPrerequisites: trickPrerequisiteDataSource(dataSourceCache),
    trickLevels: trickLevelDataSource(dataSourceCache),
    trickCompletions: trickCompletionDataSource(dataSourceCache),
    trickVideoUploads: trickVideoUploadDataSource(dataSourceCache),
    uiMessages: uiMessagesDataSource(dataSourceCache),
    users: userDataSource(dataSourceCache)
  }
}

export type DataSources = ReturnType<typeof createDataSources>
