import { Firestore } from 'firebase-admin/firestore'
import { FirestoreDataSource } from 'apollo-datasource-firestore'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { logger } from '../services/logger.js'
import { FINAL_UPLOAD_STATUSES } from '../services/mux.js'
import { usernameSchema } from '../validation.js'
import { groupInviteExpired } from './schema.js'

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

  /** Every edge, the collection is small and edges don't record their discipline */
  async findAll (options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c, options)
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

  /** Finds a user whether or not their profile is public */
  async findOneByUsernameOrId (usernameOrId: string, options?: QueryFindArgs): Promise<UserDoc | undefined> {
    const query = usernameOrId.trim()
    if (!query) return undefined

    const username = usernameSchema.safeParse(query)
    const [byId, byUsername] = await Promise.all([
      this.findOneById(query, options),
      username.success ? this.findOneByUsername(username.data, options) : undefined
    ])
    // the id wins, so a lowercase uid cannot be claimed as somebody's username
    return byId ?? byUsername
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

function byMemberOrder (a: GroupMemberDoc, b: GroupMemberDoc) {
  if (a.observer !== b.observer) return a.observer ? 1 : -1
  return a.createdAt.toMillis() - b.createdAt.toMillis()
}

export class GroupMemberDataSource extends FirestoreDataSource<GroupMemberDoc> {
  /** Safe because a data source is made per request, and every write through it clears the memo */
  private readonly memberships = new Map<string, Promise<GroupMemberDoc | undefined>>()

  forget () {
    this.memberships.clear()
  }

  /** Observers last, then oldest first */
  async findManyByGroup (groupId: string, options?: QueryFindArgs) {
    return (await this.findManyByQuery(c => c.where('groupId', '==', groupId), options)).sort(byMemberOrder)
  }

  async findManyByUser (userId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('userId', '==', userId), options)
  }

  async findOneByGroupAndUser (groupId: string, userId: string, options?: QueryFindArgs) {
    const key = `${groupId}:${userId}`
    const memoised = this.memberships.get(key)
    if (memoised) return await memoised

    const membership = this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('userId', '==', userId)
      .limit(1), options).then(members => members[0])
    this.memberships.set(key, membership)
    return await membership
  }

  async findManyAdminsByGroup (groupId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('role', '==', GroupRole.Admin), options)
  }

  async createOne (...args: Parameters<FirestoreDataSource<GroupMemberDoc>['createOne']>) {
    this.forget()
    return await super.createOne(...args)
  }

  async updateOne (...args: Parameters<FirestoreDataSource<GroupMemberDoc>['updateOne']>) {
    this.forget()
    return await super.updateOne(...args)
  }

  async updateOnePartial (...args: Parameters<FirestoreDataSource<GroupMemberDoc>['updateOnePartial']>) {
    this.forget()
    return await super.updateOnePartial(...args)
  }

  async deleteOne (...args: Parameters<FirestoreDataSource<GroupMemberDoc>['deleteOne']>) {
    this.forget()
    return await super.deleteOne(...args)
  }
}
export const groupMemberDataSource = (cache: KeyValueCache) => new GroupMemberDataSource(collection<GroupMemberDoc>('group-members'), { logger: logger.child({ name: 'group-member-data-source' }), cache })

function byNewest (a: { createdAt: Timestamp }, b: { createdAt: Timestamp }) {
  return b.createdAt.toMillis() - a.createdAt.toMillis()
}

function answerable (invites: readonly GroupInviteDoc[]) {
  return invites.filter(invite => !groupInviteExpired(invite)).sort(byNewest)
}

export class GroupInviteDataSource extends FirestoreDataSource<GroupInviteDoc> {
  /** Only the invitations still open to an answer, newest first */
  async findManyPendingByUser (userId: string, options?: QueryFindArgs) {
    return answerable(await this.findManyByQuery(c => c
      .where('userId', '==', userId)
      .where('status', '==', GroupInviteStatus.Pending), options))
  }

  /** Only the invitations still open to an answer, newest first */
  async findManyPendingByGroup (groupId: string, options?: QueryFindArgs) {
    return answerable(await this.findManyByQuery(c => c
      .where('groupId', '==', groupId)
      .where('status', '==', GroupInviteStatus.Pending), options))
  }

  async findManyByGroup (groupId: string, options?: QueryFindArgs) {
    return await this.findManyByQuery(c => c.where('groupId', '==', groupId), options)
  }

  /** Expired ones included, a caller needs to see one to clear it */
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

function recordedMillis (result: SpeedResultDoc) {
  return (result.recordedAt ?? result.createdAt).toMillis()
}

/** The first `limit` of the union of lists that each hold their own newest `limit` results */
function mergeNewest (lists: ReadonlyArray<readonly SpeedResultDoc[]>, limit?: number | null) {
  const byId = new Map<string, SpeedResultDoc>()
  for (const result of lists.flat()) byId.set(result.id, result)
  const merged = [...byId.values()].sort((a, b) => recordedMillis(b) - recordedMillis(a))
  return limit ? merged.slice(0, limit) : merged
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

  /** The scores on the user's own feed, whoever entered them */
  async findManyFeedByUser (userId: string, feed: SpeedFeedArgs = {}) {
    const [competed, unassigned] = await Promise.all([
      this.findManyByAthleteUser(userId, feed),
      this.findManyUnassignedByUser(userId, feed)
    ])
    return mergeNewest([competed, unassigned], feed.limit)
  }

  async findManyByGroup (groupId: string, { ttl, constellationKey, ...feed }: SpeedFeedArgs & { constellationKey?: string | null } = {}) {
    return await this.findManyByQuery(c => {
      let q = c.where('groupId', '==', groupId)
      if (constellationKey != null) q = q.where('constellationKey', '==', constellationKey)
      return newestFirst(q, feed)
    }, { ttl })
  }

  async existsByGroup (groupId: string) {
    return (await this.findManyByQuery(c => c.where('groupId', '==', groupId).limit(1))).length > 0
  }

  /** Commonest first, ties by key; a score nobody has been assigned to yet is no constellation */
  async findConstellationsByGroup (groupId: string, { ttl }: FindArgs = {}) {
    const results = await this.findManyByGroup(groupId, { ttl })

    const counts = new Map<string, number>()
    for (const result of results) {
      if (!result.constellationKey) continue
      counts.set(result.constellationKey, (counts.get(result.constellationKey) ?? 0) + 1)
    }

    return [...counts]
      .sort(([keyA, countA], [keyB, countB]) => countB - countA || keyA.localeCompare(keyB))
      .map(([key, resultCount]) => ({ key, resultCount }))
  }

  async findManyByAthleteMember (memberId: string, { ttl }: FindArgs = {}) {
    return await this.findManyByQuery(c => c.where('athleteMemberIds', 'array-contains', memberId), { ttl })
  }

  async existsByAthleteMember (memberId: string) {
    return (await this.findManyByQuery(c => c
      .where('athleteMemberIds', 'array-contains', memberId)
      .limit(1))).length > 0
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

  async findBestsByUser (userId: string, eventDefinitionIds: readonly string[], { ttl }: FindArgs = {}) {
    const bests = await Promise.all(eventDefinitionIds.map(async eventDefinitionId =>
      await this.findBestByUserAndEvent(userId, eventDefinitionId, { ttl })))
    return bests.filter(result => result != null)
  }

  async findBestsByMember (memberId: string, eventDefinitionIds: readonly string[], { ttl }: FindArgs = {}) {
    const bests = await Promise.all(eventDefinitionIds.map(async eventDefinitionId =>
      await this.findBestByMemberAndEvent(memberId, eventDefinitionId, { ttl })))
    return bests.filter(result => result != null)
  }
}
export const speedResultDataSource = (cache: KeyValueCache) => new SpeedResultDataSource(collection<SpeedResultDoc>('speed-results'), { logger: logger.child({ name: 'speed-result-data-source' }), cache })

/** Shortest first, then by name */
function byEventOrder (a: EventDefinitionDoc, b: EventDefinitionDoc) {
  return a.totalDuration - b.totalDuration || a.name.localeCompare(b.name)
}

export class EventDefinitionDataSource extends FirestoreDataSource<EventDefinitionDoc> {
  async findOneByLookupCode (lookupCode: string, { ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c.where('lookupCode', '==', lookupCode), { ttl }))[0]
  }

  async findAllOrdered ({ ttl }: FindArgs = {}) {
    return (await this.findManyByQuery(c => c, { ttl })).sort(byEventOrder)
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
