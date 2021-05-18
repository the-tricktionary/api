import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'

import type { Discipline, TrickType } from '../generated/graphql'
import type { ApolloContext } from '../apollo'
import type { TrickDoc, TrickLocalisationDoc, UserDoc } from './schema'
import type { CollectionReference, Query } from 'firebase-admin/firestore'

const firestore = new Firestore()

export class TrickDataSource extends FirestoreDataSource<TrickDoc, ApolloContext> {
  async findManyByFilters ({ discipline, trickType }: { discipline?: Discipline | null, trickType?: TrickType | null }, { ttl }: { ttl?: number } = {}) {
    return await this.findManyByQuery(c => {
      let q: Query<TrickDoc> = c
      if (discipline) q = q.where('discipline', '==', discipline)
      if (trickType) q = q.where('trickType', '==', trickType)
      return q
    }, { ttl })
  }
}
export const trickDataSource = new TrickDataSource(firestore.collection('tricks') as CollectionReference<TrickDoc>)
trickDataSource.initialize()

export class TrickLocalisationDataSource extends FirestoreDataSource<TrickLocalisationDoc, ApolloContext> {}
export const trickLocalisationDataSource = new TrickLocalisationDataSource(firestore.collection('trick-localisations') as CollectionReference<TrickLocalisationDoc>)
trickDataSource.initialize()

export class UserDataSource extends FirestoreDataSource<UserDoc, ApolloContext> {}
export const userDataSource = new UserDataSource(firestore.collection('users') as CollectionReference<UserDoc>)
userDataSource.initialize()
