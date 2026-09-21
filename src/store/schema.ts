import type { Discipline, GrantType, GroupInviteKind, GroupInviteStatus, GroupRole, ProfileOptions, TimingCueType, TrickType, VerificationLevel, VideoHost, VideoType, VideoUploadStatus } from '../generated/graphql.js'
import { Timestamp } from '@google-cloud/firestore'

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
  updatedBy?: UserDoc['id']

  videos: Video[]
}
export function isTrick (t: any): t is TrickDoc { return t?.collection === 'tricks' }

/** The document ID is the Mux upload ID, which is what Mux's webhooks identify the upload by */
export interface TrickVideoUploadDoc extends DocBase {
  readonly collection: 'trick-video-uploads'

  trickId: TrickDoc['id']
  userId: UserDoc['id']

  type: VideoType
  slowMoStart?: number

  status: VideoUploadStatus
  /** the Mux asset created from the upload, absent until Mux created it */
  assetId?: string
  /** why the upload failed, only set while the status is `Errored` */
  error?: string
  /**
   * When the Firestore TTL policy on the collection deletes this document. Set
   * once the upload reaches a final status, absent while it is still running.
   */
  expiresAt?: Timestamp
}
export function isTrickVideoUpload (t: any): t is TrickVideoUploadDoc { return t?.collection === 'trick-video-uploads' }

export interface TrickLocalisationDoc extends DocBase {
  readonly collection: 'trick-localisations'

  /** duplicated from the document ID to allow querying */
  trickId: TrickDoc['id']

  name: string
  alternativeNames?: string[]
  description: string

  submittedBy: UserDoc['id']
  updatedBy?: UserDoc['id']
}
export function isTrickLocalisation (t: any): t is TrickLocalisationDoc { return t?.collection === 'trick-localisations' }

export function trickLocalisationId (trickId: TrickDoc['id'], lang: string) { return `${trickId}-${lang}` }

export function trickLocalisationLang (id: TrickLocalisationDoc['id'], trickId: TrickDoc['id']) {
  return id.startsWith(`${trickId}-`) ? id.slice(trickId.length + 1) : undefined
}

export interface LanguageDoc extends DocBase {
  readonly collection: 'languages'

  /** whether the public site offers the language */
  enabled: boolean
}
export function isLanguage (t: any): t is LanguageDoc { return t?.collection === 'languages' }

export interface UiMessageLeaf {
  value: string
  /** The English message this was translated from, absent for translations saved before we recorded it */
  source?: string
  updatedBy: UserDoc['id']
  updatedAt: Timestamp
}

/**
 * The public site's interface strings in a single language, the document ID is
 * the language tag. English is the source language and lives in the site's own
 * repository rather than here.
 */
export interface UiMessagesDoc extends DocBase {
  readonly collection: 'ui-messages'

  /** keyed like the site's en.json, `trick.level`, one field per message so saves merge per key */
  messages: Record<string, UiMessageLeaf>
}
export function isUiMessages (t: any): t is UiMessagesDoc { return t?.collection === 'ui-messages' }

export interface RulesetDoc extends DocBase {
  readonly collection: 'rulesets'

  /** lang -> display name, 'en' is required */
  names: Record<string, string>
  /** exactly one ruleset is primary */
  isPrimary: boolean
}
export function isRuleset (t: any): t is RulesetDoc { return t?.collection === 'rulesets' }

/**
 * The Tricktionary's own ruleset, its levels are the 1-5 levels shown on the
 * trick itself and are maintained by trick editors rather than level editors.
 */
export const TRICKTIONARY_RULES_ID = 'tricktionary'

export interface TrickLevelDoc extends DocBase {
  readonly collection: 'trick-levels'

  trickId: TrickDoc['id']
  rulesId: RulesetDoc['id']
  /** "5" or "2-5" */
  level: string
  /** absent while the level is unverified */
  verificationLevel?: VerificationLevel
  verifiedBy?: UserDoc['id']
  verifiedAt?: Timestamp
  /** absent on levels migrated from before edits were tracked */
  updatedBy?: UserDoc['id']
}
export function isTrickLevel (t: any): t is TrickLevelDoc { return t?.collection === 'trick-levels' }

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
 * - `SuperAdmin` implies every other grant, for every language and every
 *   ruleset, including verifying levels at the highest verification level.
 * - `TrickEditor` may edit tricks and implies `Translator` for `en`
 *   (english is the source language of the Tricktionary, so it's hard-coded
 *   and never granted as a `Translator` grant).
 * - `Translator` may edit trick localisations in a single language, the
 *   `lang` is a BCP-47 tag and is never `en`.
 * - `LevelEditor` may edit trick levels for a single ruleset. The
 *   `verificationLevel` is the highest level the user may verify a level at,
 *   ranked absent (0) < `JUDGE` (1) < `OFFICIAL` (2), meaning a grant without
 *   a verification level allows editing levels but not verifying them.
 */
export type Grant =
  | { type: GrantType.SuperAdmin }
  | { type: GrantType.TrickEditor }
  | { type: GrantType.Translator, lang: string }
  | { type: GrantType.LevelEditor, rulesId: string, verificationLevel?: VerificationLevel }
  | { type: GrantType.SpeedEditor }

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

/** A claimed username, the document ID is the username */
export interface UsernameDoc extends DocBase {
  readonly collection: 'usernames'
  userId: UserDoc['id']
}
export function isUsername (t: any): t is UsernameDoc { return t?.collection === 'usernames' }

export interface GroupDoc extends DocBase {
  readonly collection: 'groups'
  name: string
  createdBy: UserDoc['id']
  joinCode?: string
}
export function isGroup (t: any): t is GroupDoc { return t?.collection === 'groups' }

export interface GroupMemberDoc extends DocBase {
  readonly collection: 'group-members'
  groupId: GroupDoc['id']
  /** Absent for an athlete the group manages, set when an invite claims the row */
  userId?: UserDoc['id']
  name?: string
  role: GroupRole
  /** Left out of the group's checklist and speed scores, never true without a `userId` */
  observer: boolean
}
export function isGroupMember (t: any): t is GroupMemberDoc { return t?.collection === 'group-members' }

export interface GroupInviteDoc extends DocBase {
  readonly collection: 'group-invites'
  groupId: GroupDoc['id']
  userId: UserDoc['id']
  kind: GroupInviteKind
  role: GroupRole
  observer: boolean
  memberId?: GroupMemberDoc['id']
  /** The admin who invited, absent on a request to join */
  invitedBy?: UserDoc['id']
  status: GroupInviteStatus
  /** Firestore's TTL policy deletes the document once this passes */
  expiresAt: Timestamp
}

export const GROUP_INVITE_TTL_DAYS = 30

export function groupInviteExpiry () {
  return Timestamp.fromMillis(Date.now() + (GROUP_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000))
}

/** TTL deletion can lag by a day, so an expired invite is refused on its own terms too */
export function groupInviteExpired (invite: GroupInviteDoc) {
  return invite.expiresAt.toMillis() <= Date.now()
}
export function isGroupInvite (t: any): t is GroupInviteDoc { return t?.collection === 'group-invites' }

/** Named by `userId` for an athlete with an account, and by `memberId` for one without */
export interface TrickCompletionDoc extends DocBase {
  readonly collection: 'trick-completions'
  userId?: UserDoc['id']
  memberId?: GroupMemberDoc['id']
  trickId: TrickDoc['id']
  recordedBy?: UserDoc['id']
}

export type ChecklistAthlete =
  | { userId: string, memberId?: undefined }
  | { userId?: undefined, memberId: string }

export function checklistAthlete (member: GroupMemberDoc): ChecklistAthlete {
  return member.userId != null ? { userId: member.userId } : { memberId: member.id }
}
export function isTrickCompletion (t: any): t is TrickDoc { return t?.collection === 'trick-completions' }

/**
 * A mark in the same shape as the @ropescore/rulesets mark stream, stored with
 * a millisecond epoch timestamp rather than a Firestore Timestamp so the array
 * can be passed straight to the library's reducers.
 */
export interface SpeedMark {
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

  /** When the score was jumped */
  recordedAt?: Timestamp

  count: number
  /** The steps of each leg of a plain-count relay, one per segment of the event */
  segmentCounts?: number[]

  // either we link this to an event definition
  eventDefinitionId?: EventDefinitionDoc['id']
  // or we have the fields below set for custom stuff
  // the event definition always takes precedent if present
  eventDefinition?: {
    totalDuration: number
    name: string
    /** Athlete switches in a custom relay, always of type Switch */
    cues?: TimingCue[]
  }

  /** The mark stream the result was counted from, absent for plain counts */
  marks?: SpeedMark[]
  /**
   * The event's timing track as it was when the result was recorded with it,
   * stripped of its audio and measured from the go signal when the audio was
   * not played, see helpers/speedMarks.ts trackWithoutAudio
   */
  timingTrack?: TimingTrack

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

  groupId?: GroupDoc['id']
  participants?: SpeedParticipant[]

  // Derived from `participants` on every write, never taken from the input
  athleteMemberIds: string[]
  wholeScoreMemberId?: GroupMemberDoc['id']
  /** The accounts behind `athleteMemberIds`, or the creator when there is no group */
  athleteUserIds: string[]
  wholeScoreUserId?: UserDoc['id']
  needsParticipants?: boolean
  /** The distinct member ids that competed, sorted and joined with `|` */
  constellationKey?: string
}

export interface SpeedParticipant {
  /** Absent when the athlete competed the whole result rather than one segment */
  segmentIndex?: number
  memberId: GroupMemberDoc['id']
  /**
   * The account behind `memberId`, absent for an athlete the group manages.
   * An index for looking a leg up by user, never exposed on its own.
   */
  userId?: UserDoc['id']
}
export function isSpeedResult (t: any): t is SpeedResultDoc { return t?.collection === 'speed-results' }

export interface TimingCue {
  type: TimingCueType
  /** Milliseconds from the start of the audio, or from the go signal when the track has no audio */
  offset: number
  label?: string
}

/** Stored inline on an event definition, and snapshotted onto results recorded with it */
export interface TimingTrack {
  /** Public URL of the audio object, see services/storage.ts, absent for cues without audio */
  audioUrl?: string
  cues: TimingCue[]
}

export interface EventDefinitionDoc extends DocBase {
  collection: 'event-definitions'
  name: string
  totalDuration: number
  /** Rulesets competition event lookup code (without version), if this is a known competition event */
  lookupCode?: string
  timingTrack?: TimingTrack
  updatedBy?: UserDoc['id']
}
export function isEventDefinition (t: any): t is EventDefinitionDoc { return t?.collection === 'event-definitions' }
