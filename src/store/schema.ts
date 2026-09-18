import type { Discipline, ProfileOptions, TrickType, VerificationLevel, VideoHost, VideoType } from '../generated/graphql'
import type { Timestamp } from '@google-cloud/firestore'

export interface DocBase {
  readonly id: string
  readonly collection: string
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

interface VideoBase {
  host: VideoHost
  /** Host-specific identifier of the video, see the individual hosts */
  videoId: string
  type: VideoType
  slowMoStart?: number | null
}

export interface YouTubeVideo extends VideoBase {
  host: VideoHost.YouTube
  /** The YouTube video ID */
  videoId: string
}

export interface MuxVideo extends VideoBase {
  host: VideoHost.Mux
  /** The public Mux playback ID, this is what clients need for playback */
  videoId: string
  /**
   * The Mux asset ID the playback ID belongs to, needed for managing the asset
   * (deleting it, adding renditions, ...) through the Mux API
   */
  assetId: string
}

/** A video embedded in a trick document */
export type Video = YouTubeVideo | MuxVideo

export interface TrickDoc extends DocBase {
  readonly collection: 'tricks'
  slug: string
  discipline: Discipline
  trickType: TrickType

  submittedBy: UserDoc['id']

  videos: Video[]
}
export function isTrick (t: any): t is TrickDoc { return t?.collection === 'tricks' }

export interface TrickLocalisationDoc extends DocBase {
  readonly collection: 'trick-localisations'

  name: string
  alternativeNames?: string[]
  description: string

  submittedBy: UserDoc['id']
}
export function isTrickLocalisation (t: any): t is TrickLocalisationDoc { return t?.collection === 'trick-localisations' }

export interface UnverifiedTrickLevelDoc extends DocBase {
  readonly collection: 'trick-levels'

  trickId: TrickDoc['id']
  organisation: string
  level: string
  rulesVersion?: string
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
}
export function isTrickPrereq (t: any): t is TrickDoc { return t?.collection === 'trick-prerequisites' }

export interface UserDoc extends DocBase {
  readonly collection: 'users'
  username?: string
  name?: string
  lang?: string
  photo?: string
  email?: string
  profile: Omit<ProfileOptions, '__typename'>
}
export function isUser (t: any): t is TrickDoc { return t?.collection === 'users' }

export interface TrickCompletionDoc extends DocBase {
  readonly collection: 'trick-completions'
  userId: UserDoc['id']
  trickId: TrickDoc['id']
}
export function isTrickCompletion (t: any): t is TrickDoc { return t?.collection === 'trick-completions' }

/**
 * A mark in the same shape as the @ropescore/rulesets mark stream, stored with
 * a millisecond epoch timestamp rather than a Firestore Timestamp so the array
 * can be passed straight to the library's reducers.
 */
export interface SpeedMarkDoc {
  sequence: number
  timestamp: number
  schema: string
  value?: number
  target?: number
}

export interface SpeedResultDoc extends DocBase {
  readonly collection: 'speed-results'
  name?: string
  userId: UserDoc['id']

  count: number

  // either we link this to an event definition
  eventDefinitionId?: EventDefinitionDoc['id']
  // or we have the fields below set for custom stuff
  // the event definition always takes precedent if present
  eventDefinition?: {
    totalDuration: number
    name: string
  }

  /** The mark stream the result was counted from, absent for plain counts */
  marks?: SpeedMarkDoc[]

  /**
   * Legacy: absolute click timestamps recorded by the first v4 API, see
   * src/migrations/speed-marks.ts which converts these into marks
   */
  clicks?: Timestamp[]
  /**
   * Legacy: pairwise averaged click offsets in 10 ms units, mirrored from
   * the v2 realtime database, see src/migrations/speed-marks.ts
   */
  graphData?: number[]
  /** Key of the mirrored v2 realtime database entry, kept so deletes propagate */
  rtdKey?: string
}
export function isSpeedResult (t: any): t is SpeedResultDoc { return t?.collection === 'speed-results' }

export interface EventDefinitionDoc extends DocBase {
  collection: 'event-definitions'
  name: string
  totalDuration: number
  /** Rulesets competition event lookup code (without version), if this is a known competition event */
  lookupCode?: string
}
export function isEventDefinition (t: any): t is EventDefinitionDoc { return t?.collection === 'event-definitions' }
