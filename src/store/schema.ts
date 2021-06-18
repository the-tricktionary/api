import type { Discipline, ProfileOptions, TrickType, VerificationLevel, Video } from '../generated/graphql'
import type { Timestamp } from '@google-cloud/firestore'

export interface DocBase {
  readonly id: string
  readonly collection: string
}

export interface TrickDoc extends DocBase {
  readonly collection: 'tricks'
  slug: string
  discipline: Discipline
  trickType: TrickType

  createdAt: Timestamp
  updatedAt: Timestamp
  submittedBy: UserDoc['id']

  videos: Array<Omit<Video, '__typename'>>
}
export function isTrick (t: any): t is TrickDoc { return t?.collection === 'tricks' }

export interface TrickLocalisationDoc extends DocBase {
  readonly collection: 'trick-localisations'

  name: string
  alternativeNames?: string[]
  description: string

  createdAt: Timestamp
  updatedAt: Timestamp
  submittedBy: UserDoc['id']
}
export function isTrickLocalisation (t: any): t is TrickLocalisationDoc { return t?.collection === 'trick-localisations' }

export interface UnverifiedTrickLevelDoc extends DocBase {
  readonly collection: 'trick-levels'

  trickId: TrickDoc['id']
  organisation: string
  level: string
  rulesVersion?: string

  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface VerifiedTrickLevelDoc extends UnverifiedTrickLevelDoc {
  verifiedBy: UserDoc['id']
  verificationLevel: VerificationLevel
}

export type TrickLevelDoc = UnverifiedTrickLevelDoc | VerifiedTrickLevelDoc
export function isTrickLevel (t: any): t is TrickLevelDoc { return t?.collection === 'trick-levels' }

export interface TrickPrereqDoc extends DocBase {
  readonly collection: 'trick-prerequisites'
  parentId: TrickDoc['id']
  childId: TrickDoc['id']
  createdAt: Timestamp
}
export function isTrickPrereq (t: any): t is TrickDoc { return t?.collection === 'trick-prerequisites' }

export interface UserDoc extends DocBase {
  readonly collection: 'users'
  username?: string
  name?: string
  lang?: string
  photo?: string
  profile: Omit<ProfileOptions, '__typename'>
}
export function isUser (t: any): t is TrickDoc { return t?.collection === 'users' }

export interface TrickCompletionDoc extends DocBase {
  readonly collection: 'trick-completions'
  userId: UserDoc['id']
  trickId: TrickDoc['id']
  createdAt: Timestamp
}
export function isTrickCompletion (t: any): t is TrickDoc { return t?.collection === 'trick-completions' }

export type SpeedResultDoc = SimpleSpeedResultDoc | DetailedSpeedResultDoc
export function isSpeedResult (t: any): t is SpeedResultDoc { return t?.collection === 'speed' }

export interface SimpleSpeedResultDoc extends DocBase {
  readonly collection: 'speed-results'
  name?: string
  userId: UserDoc['id']
  createdAt: Timestamp

  count: number
  eventDefinitionId: EventDefinitionDoc['id']
}
export function isSimpleSpeedResult (t: any): t is SimpleSpeedResultDoc { return t?.collection === 'speed-results' && !t.clicks }

export interface DetailedSpeedResultDoc extends SimpleSpeedResultDoc {
  clicks: Timestamp[]
}
export function isDetailedSpeedResult (t: any): t is DetailedSpeedResultDoc { return t?.collection === 'speed-results' && !!t.clicks }

export interface EventDefinitionDoc extends DocBase {
  collection: 'event-definitions'
  name: string
  totalDuration: number
  lookupCode?: string
}
export function isEventDefinition (t: any): t is EventDefinitionDoc { return t?.collection === 'event-definitions' }
