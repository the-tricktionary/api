import { analysisOf, enteredSegments } from './speedMarks.js'

import type { EventDefinitionDoc, GroupMemberDoc, SpeedParticipant, SpeedResultDoc } from '../store/schema.js'
import type { SpeedSegment } from './speedMarks.js'

/** The athlete a score is read for: an account, or an athlete a group manages */
export type SpeedAthlete =
  | { userId: string, memberId?: undefined }
  | { userId?: undefined, memberId: string }

export interface SpeedSegmentResult {
  result: SpeedResultDoc
  /** Absent when the athlete competed the whole result */
  segment?: SpeedSegment
  count: number
  stepsPerSecond?: number
}

export interface GroupConstellation {
  key: string
  members: GroupMemberDoc[]
  resultCount: number
}

function participantOf (result: SpeedResultDoc, athlete: SpeedAthlete): SpeedParticipant | undefined {
  return result.participants?.find(participant => athlete.userId != null
    ? participant.userId === athlete.userId
    : participant.memberId === athlete.memberId)
}

export function segmentResultOf (result: SpeedResultDoc, athlete: SpeedAthlete, eventDefinition: EventDefinitionDoc): SpeedSegmentResult {
  const segmentIndex = participantOf(result, athlete)?.segmentIndex
  const analysis = analysisOf(result, eventDefinition)
  const segments = analysis?.segments ?? enteredSegments(result, eventDefinition)
  const segment = segmentIndex != null ? segments[segmentIndex] : undefined
  if (segment) return { result, segment, count: segment.count, stepsPerSecond: segment.stepsPerSecond }
  return { result, count: result.count, ...(analysis ? { stepsPerSecond: analysis.stepsPerSecond } : {}) }
}
