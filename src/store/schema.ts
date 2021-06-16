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
export function isTrick (t: any): t is TrickDoc {
  return t?.collection === 'tricks'
}

export interface TrickLocalisationDoc extends DocBase {
  readonly collection: 'trick-localisations'

  name: string
  alternativeNames?: string[]
  description: string

  createdAt: Timestamp
  updatedAt: Timestamp
  submittedBy: UserDoc['id']
}

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

export interface TrickPrereqDoc extends DocBase {
  readonly collection: 'prerequisites'
  parentId: TrickDoc['id']
  childId: TrickDoc['id']
  createdAt: Timestamp
}

export interface UserDoc extends DocBase {
  readonly collection: 'users'
  username?: string
  name?: string
  lang?: string
  photo?: string
  profile: Omit<ProfileOptions, '__typename'>
}
