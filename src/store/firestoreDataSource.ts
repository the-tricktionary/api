import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { logger } from '../services/logger.js'
import { FINAL_UPLOAD_STATUSES } from '../services/mux.js'

import type { Discipline } from '../generated/graphql.js'
import type { ChecklistAthlete, TrickPrereqDoc, TrickDoc, TrickLocalisationDoc, UserDoc, TrickLevelDoc, TrickCompletionDoc, SpeedResultDoc, EventDefinitionDoc, GroupDoc, GroupInviteDoc, GroupMemberDoc, LanguageDoc, RulesetDoc, TrickVideoUploadDoc, UiMessagesDoc, UsernameDoc } from './schema.js'
import { GroupInviteStatus, GroupRole } from '../generated/graphql.js'
import type { CollectionReference, DocumentData, DocumentReference, Query, WriteBatch } from 'firebase-admin/firestore'
import type { FindArgs, QueryFindArgs } from 'apollo-datasource-firestore'
import type { Timestamp } from '@google-cloud/firestore'
import type { KeyValueCache } from '@apollo/utils.keyvaluecache'

/** For transactions spanning collections */
export const firestore = new Firestore()

/** Firestore takes 500 writes to a batch */
const WRITE_CHUNK = 400

export async function writeInChunks<T> (items: readonly T[], apply: (batch: WriteBatch, item: T) => void) {
  for (let idx = 0; idx < items.length; idx += WRITE_CHUNK) {
    const batch = firestore.batch()
    for (const item of items.slice(idx, idx + WRITE_CHUNK)) apply(batch, item)
    await batch.commit()
  }
}

export async function deleteInChunks (refs: Array<DocumentReference<any>>) {
  await writeInChunks(refs, (batch, ref) => { batch.delete(ref) })
}

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

  async findOneByUsername (username: string, options?: QueryFindArgs) {
    return (await this.findManyByQuery(c => c.where('username', '==', username), options))[0]
  }
}
export const userDataSource = (cache: KeyValueCache) => new UserDataSource(collection<UserDoc>('users'), { logger: logger.child({ name: 'user-data-source' }), cache })

/** Username reservations, keyed by the username */
export class UsernameDataSource extends FirestoreDataSource<UsernameDoc> {}
export const usernameDataSource = (cache: KeyValueCache) => new UsernameDataSource(collection<UsernameDoc>('usernames'), { logger: logger.child({ name: 'username-data-source' }), cache })

export class GroupDataSource extends FirestoreDataSource<GroupDoc> {
  async findOneByJoinCode (joinCode: string, options?: QueryFindArgs) {
    return (await this.findManyByQuery(c => c.where('joinCode', '==', joinCode).limit(1), options))[0]
  }
}
export const groupDataSource = (cache: KeyValueCache) => new GroupDataSource(collection<GroupDoc>('groups'), { logger: logger.child({ name: 'group-data-source' }), cache })

export class GroupMemberDataSource extends FirestoreDataSource<GroupMemberDoc> {
  async findManyByGroup (groupId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('groupId', '==', groupId), options)
  }

  async findManyByUser (userId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('userId', '==', userId), options)
  }

  /** Nobody holds two rows in one group, see `respondToGroupInvite` */
  async findOneByGroupAndUser (groupId: string, userId: string, options?: QueryFindArgs) {
    return (await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('userId', '==', userId)
      .limit(1), options))[0]
  }

  async findManyAdminsByGroup (groupId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('role', '==', GroupRole.Admin), options)
  }
}
export const groupMemberDataSource = (cache: KeyValueCache) => new GroupMemberDataSource(collection<GroupMemberDoc>('group-members'), { logger: logger.child({ name: 'group-member-data-source' }), cache })

/**
 * Invitations and requests to join. Both lists are small enough to sort in
 * memory, which is also the only way to order them by `createdAt`: the data
 * source's converter derives that from the document's own create time rather
 * than storing a field, so Firestore has nothing to order by.
 */
export class GroupInviteDataSource extends FirestoreDataSource<GroupInviteDoc> {
  async findManyPendingByUser (userId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('userId', '==', userId)
      .where('status', '==', GroupInviteStatus.Pending), options)
  }

  async findManyPendingByGroup (groupId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('status', '==', GroupInviteStatus.Pending), options)
  }

  async findOnePendingByGroupAndUser (groupId: string, userId: string, options?: QueryFindArgs) {
    return (await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('userId', '==', userId)
      .where('status', '==', GroupInviteStatus.Pending)
      .limit(1), options))[0]
  }
}
export const groupInviteDataSource = (cache: KeyValueCache) => new GroupInviteDataSource(collection<GroupInviteDoc>('group-invites'), { logger: logger.child({ name: 'group-invite-data-source' }), cache })

export class TrickCompletionDataSource extends FirestoreDataSource<TrickCompletionDoc> {
  async findManyByUser (userId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => c.where('userId', '==', userId), { ttl })
  }

  async findManyByMember (memberId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => c.where('memberId', '==', memberId), { ttl })
  }

  async findManyByAthlete (athlete: ChecklistAthlete, { ttl }: FindArgs = {}) {
    return athlete.userId != null
      ? await this.findManyByUser(athlete.userId, { ttl })
      : await this.findManyByMember(athlete.memberId, { ttl })
  }

  async findOneByAthleteAndTrick (athlete: ChecklistAthlete, trickId: string) {
    return (await this.findManyByQuery(c => (athlete.userId != null
      ? c.where('userId', '==', athlete.userId)
      : c.where('memberId', '==', athlete.memberId)
    ).where('trickId', '==', trickId).limit(1)))[0]
  }
}
export const trickCompletionDataSource = (cache: KeyValueCache) => new TrickCompletionDataSource(collection<TrickCompletionDoc>('trick-completions'), { logger: logger.child({ name: 'trick-completion-source' }), cache })

interface SpeedFeedArgs extends FindArgs {
  limit?: number | null
  startAfter?: Timestamp | null
  eventDefinitionId?: string | null
}

function newestFirst (query: Query<SpeedResultDoc>, { limit, startAfter, eventDefinitionId }: SpeedFeedArgs) {
  let q = query
  if (eventDefinitionId) q = q.where('eventDefinitionId', '==', eventDefinitionId)
  q = q.orderBy('recordedAt', 'desc')
  if (startAfter) q = q.startAfter(startAfter)
  if (limit) q = q.limit(limit)
  return q
}

export class SpeedResultDataSource extends FirestoreDataSource<SpeedResultDoc> {
  /** The scores the user competed in, whether or not they entered them */
  async findManyByAthleteUser (userId: string, { ttl, ...feed }: SpeedFeedArgs = {}) {
    return await this.findManyByQuery(c => newestFirst(c.where('athleteUserIds', 'array-contains', userId), feed), { ttl })
  }

  /** The scores the user entered and has not yet said who competed in */
  async findManyUnassignedByUser (userId: string, { ttl, ...feed }: SpeedFeedArgs = {}) {
    return await this.findManyByQuery(c => newestFirst(c
      .where('userId', '==', userId)
      .where('needsParticipants', '==', true), feed), { ttl })
  }

  async findManyByGroup (groupId: string, { ttl, constellationKey, ...feed }: SpeedFeedArgs & { constellationKey?: string | null } = {}) {
    return await this.findManyByQuery(c => {
      let q = c.where('groupId', '==', groupId)
      if (constellationKey != null) q = q.where('constellationKey', '==', constellationKey)
      return newestFirst(q, feed)
    }, { ttl })
  }

  async findManyByAthleteMemberAndEvent (memberId: string, eventDefinitionId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => newestFirst(c.where('athleteMemberIds', 'array-contains', memberId), { eventDefinitionId }), { ttl })
  }

  /** The user's highest score in an event among the ones they competed whole */
  async findBestByUserAndEvent (userId: string, eventDefinitionId: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c
      .where('wholeScoreUserId', '==', userId)
      .where('eventDefinitionId', '==', eventDefinitionId)
      .orderBy('count', 'desc')
      .limit(1), { ttl }))[0]
  }

  /** The member's highest score in an event among the group's scores they competed whole */
  async findBestByMemberAndEvent (memberId: string, eventDefinitionId: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c
      .where('wholeScoreMemberId', '==', memberId)
      .where('eventDefinitionId', '==', eventDefinitionId)
      .orderBy('count', 'desc')
      .limit(1), { ttl }))[0]
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
    groups: groupDataSource(dataSourceCache),
    groupInvites: groupInviteDataSource(dataSourceCache),
    groupMembers: groupMemberDataSource(dataSourceCache),
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
    users: userDataSource(dataSourceCache),
    usernames: usernameDataSource(dataSourceCache)
  }
}

export type DataSources = ReturnType<typeof createDataSources>
