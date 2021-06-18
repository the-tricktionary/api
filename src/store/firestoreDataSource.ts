import { Firestore } from 'firebase-admin/firestore'
import { FindArgs, FirestoreDataSource } from 'apollo-datasource-firestore'
import { logger } from '../services/logger'

import type { Discipline, TrickType } from '../generated/graphql'
import type { ApolloContext } from '../apollo'
import type { TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc, TrickCompletionDoc, SpeedResultDoc, EventDefinitionDoc } from './schema'
import type { CollectionReference, Query } from 'firebase-admin/firestore'
import type { QueryFindArgs } from 'apollo-datasource-firestore/dist/datasource'

const firestore = new Firestore()

export class TrickDataSource extends FirestoreDataSource<TrickDoc, ApolloContext> {
  async findManyByFilters ({ discipline, trickType }: { discipline?: Discipline | null, trickType?: TrickType | null }, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q: Query<TrickDoc> = c
      if (discipline) q = q.where('discipline', '==', discipline)
      if (trickType) q = q.where('trickType', '==', trickType)
      return q
    }, options)
  }

  async findOneBySlug ({ discipline, slug }: { discipline: Discipline, slug: string }, options?: QueryFindArgs) {
    const result = await this.findManyByQuery(c => c.where('discipline', '==', discipline).where('slug', '==', slug), options)
    return result[0]
  }
}
export const trickDataSource = new TrickDataSource(firestore.collection('tricks') as CollectionReference<TrickDoc>, { logger: logger.child({ name: 'trick-data-source' }) })
trickDataSource.initialize()

export class TrickLocalisationDataSource extends FirestoreDataSource<TrickLocalisationDoc, ApolloContext> {}
export const trickLocalisationDataSource = new TrickLocalisationDataSource(firestore.collection('trick-localisations') as CollectionReference<TrickLocalisationDoc>, { logger: logger.child({ name: 'trick-localisation-data-source' }) })
trickLocalisationDataSource.initialize()

export class TrickLevelDataSource extends FirestoreDataSource<TrickLevelDoc, ApolloContext> {
  async findManyByFilters ({ trickId, organisation, rulesVersion }: { trickId: string, organisation?: string | null, rulesVersion?: string | null }, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => {
      let q = c.where('trickId', '==', trickId)
      if (organisation) q = q.where('organisation', '==', organisation)
      if (rulesVersion) q = q.where('rulesVersion', '==', rulesVersion)
      return q
    }, options)
  }
}
export const trickLevelDataSource = new TrickLevelDataSource(firestore.collection('trick-levels') as CollectionReference<TrickLevelDoc>, { logger: logger.child({ name: 'trick-level-data-source' }) })
trickLevelDataSource.initialize()

export class TrickPrerequisiteDataSource extends FirestoreDataSource<TrickPrereqDoc, ApolloContext> {
  async findManyPrerequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('parentId', '==', trickId), options)
  }

  async findManyRequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('childId', '==', trickId), options)
  }
}
export const trickPrerequisiteDataSource = new TrickPrerequisiteDataSource(firestore.collection('trick-prerequisites') as CollectionReference<TrickPrereqDoc>, { logger: logger.child({ name: 'trick-prerequisite-data-source' }) })
trickPrerequisiteDataSource.initialize()

export class UserDataSource extends FirestoreDataSource<UserDoc, ApolloContext> {}
export const userDataSource = new UserDataSource(firestore.collection('users') as CollectionReference<UserDoc>, { logger: logger.child({ name: 'user-data-source' }) })
userDataSource.initialize()

export class TrickCompletionDataSource extends FirestoreDataSource<TrickCompletionDoc, ApolloContext> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }
}
export const trickCompletionDataSource = new TrickCompletionDataSource(firestore.collection('trick-completions') as CollectionReference<TrickCompletionDoc>, { logger: logger.child({ name: 'trick-completion-source' }) })
trickCompletionDataSource.initialize()

export class SpeedResultDataSource extends FirestoreDataSource<SpeedResultDoc, ApolloContext> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }
}
export const speedResultDataSource = new SpeedResultDataSource(firestore.collection('speed-results') as CollectionReference<SpeedResultDoc>, { logger: logger.child({ name: 'speed-result-data-source' }) })
speedResultDataSource.initialize()

export class EventDefinitionDataSource extends FirestoreDataSource<EventDefinitionDoc, ApolloContext> {
  async findOneByLookupCode (lookupCode: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c.where('lookupCode', '==', lookupCode), { ttl }))[0]
  }
}
export const eventDefinitionDataSource = new EventDefinitionDataSource(firestore.collection('event-definitions') as CollectionReference<EventDefinitionDoc>, { logger: logger.child({ name: 'event-definition-data-source' }) })
eventDefinitionDataSource.initialize()
