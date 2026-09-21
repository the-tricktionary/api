import { analysisOf } from './speedMarks.js'

import type { EventDefinitionDoc, GroupMemberDoc, SpeedResultDoc } from '../store/schema.js'
import type { SpeedSegment } from './speedMarks.js'

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

export function segmentResultOf (result: SpeedResultDoc, memberId: string, eventDefinition: EventDefinitionDoc): SpeedSegmentResult {
  const segmentIndex = result.participants?.find(participant => participant.memberId === memberId)?.segmentIndex
  const analysis = analysisOf(result, eventDefinition)
  const segment = segmentIndex != null ? analysis?.segments[segmentIndex] : undefined
  if (segment) return { result, segment, count: segment.count, stepsPerSecond: segment.stepsPerSecond }
  return { result, count: result.count, ...(analysis ? { stepsPerSecond: analysis.stepsPerSecond } : {}) }
}
