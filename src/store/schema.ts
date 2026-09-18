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

export interface RulesetDoc extends DocBase {
  readonly collection: 'rulesets'

  /** lang -> display name, 'en' is required */
  names: Record<string, string>
  /** exactly one ruleset is primary */
  isPrimary: boolean
}
export function isRuleset (t: any): t is RulesetDoc { return t?.collection === 'rulesets' }

export interface TrickLevelDoc extends DocBase {
  readonly collection: 'trick-levels'

  trickId: TrickDoc['id']
  /** references RulesetDoc.id, e.g. `ijru@5.0.0` or `tricktionary` */
  rulesId: RulesetDoc['id']
  /** "5" or "2-5" */
  level: string
  verificationLevel: VerificationLevel | null
  verifiedBy: UserDoc['id'] | null
  verifiedAt: Timestamp | null
  updatedBy: UserDoc['id']
}
export function isTrickLevel (t: any): t is TrickLevelDoc { return t?.collection === 'trick-levels' }

/**
 * Trick levels are unique per trick and ruleset, so their document ID is
 * deterministic rather than random.
 */
export function trickLevelId (trickId: TrickDoc['id'], rulesId: RulesetDoc['id']) { return `${trickId}-${rulesId}` }

export interface TrickPrereqDoc extends DocBase {
  readonly collection: 'trick-prerequisites'
  parentId: TrickDoc['id']
  childId: TrickDoc['id']
}
export function isTrickPrereq (t: any): t is TrickDoc { return t?.collection === 'trick-prerequisites' }

/**
 * An administrative privilege granted to a user.
 *
 * - `super-admin` implies every other grant, for every language and every
 *   ruleset, including verifying levels at the highest verification level.
 * - `trick-editor` may edit tricks and implies `translator` for `en`
 *   (english is the source language of the Tricktionary, so it's hard-coded
 *   and never granted as a `translator` grant).
 * - `translator` may edit trick localisations in a single language, the
 *   `lang` is a BCP-47 tag and is never `en`.
 * - `level-editor` may edit trick levels for a single ruleset. The
 *   `verificationLevel` is the highest level the user may verify a level at,
 *   ranked `null` (0) < `JUDGE` (1) < `OFFICIAL` (2), meaning a `null`
 *   verification level allows editing levels but not verifying them.
 */
export type Grant =
  | { type: 'super-admin' }
  | { type: 'trick-editor' }
  | { type: 'translator', lang: string }
  | { type: 'level-editor', rulesId: string, verificationLevel: VerificationLevel | null }

export interface UserDoc extends DocBase {
  readonly collection: 'users'
  username?: string
  name?: string
  lang?: string
  photo?: string
  email?: string
  profile: Omit<ProfileOptions, '__typename'>
  grants?: Grant[]
}
export function isUser (t: any): t is TrickDoc { return t?.collection === 'users' }

export interface TrickCompletionDoc extends DocBase {
  readonly collection: 'trick-completions'
  userId: UserDoc['id']
  trickId: TrickDoc['id']
}
export function isTrickCompletion (t: any): t is TrickDoc { return t?.collection === 'trick-completions' }

export type SpeedResultDoc = SimpleSpeedResultDoc | DetailedSpeedResultDoc
export function isSpeedResult (t: any): t is SpeedResultDoc { return t?.collection === 'speed' }

export interface SimpleSpeedResultDoc extends DocBase {
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
}
export function isEventDefinition (t: any): t is EventDefinitionDoc { return t?.collection === 'event-definitions' }
