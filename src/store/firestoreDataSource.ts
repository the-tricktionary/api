import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'

import type { Discipline, TrickType } from '../generated/graphql'
import type { ApolloContext } from '../apollo'
import type { TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc } from './schema'
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
export const trickDataSource = new TrickDataSource(firestore.collection('tricks') as CollectionReference<TrickDoc>)
trickDataSource.initialize()

export class TrickLocalisationDataSource extends FirestoreDataSource<TrickLocalisationDoc, ApolloContext> {}
export const trickLocalisationDataSource = new TrickLocalisationDataSource(firestore.collection('trick-localisations') as CollectionReference<TrickLocalisationDoc>)
trickDataSource.initialize()

export class TrickPrerequisiteDataSource extends FirestoreDataSource<TrickPrereqDoc, ApolloContext> {
  async findManyPrerequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('parentId', '==', trickId), options)
  }

  async findManyRequisitesByTrick (trickId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('childId', '==', trickId), options)
  }
}
export const trickPrerequisiteDataSource = new TrickPrerequisiteDataSource(firestore.collection('trick-prerequisites') as CollectionReference<TrickPrereqDoc>)
trickPrerequisiteDataSource.initialize()

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
export const trickLevelDataSource = new TrickLevelDataSource(firestore.collection('trick-levels') as CollectionReference<TrickLevelDoc>)
trickLevelDataSource.initialize()

export class UserDataSource extends FirestoreDataSource<UserDoc, ApolloContext> {}
export const userDataSource = new UserDataSource(firestore.collection('users') as CollectionReference<UserDoc>)
userDataSource.initialize()
