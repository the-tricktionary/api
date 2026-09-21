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

export interface SpeedPersonalBest {
  eventDefinition: EventDefinitionDoc
  total: SpeedResultDoc
  /** Absent when the athlete never competed a leg of the event */
  ownSegment?: SpeedSegmentResult
}

export interface GroupConstellation {
  key: string
  members: GroupMemberDoc[]
  resultCount: number
}

export function recordedMillis (result: Pick<SpeedResultDoc, 'recordedAt' | 'createdAt'>) {
  return (result.recordedAt ?? result.createdAt).toMillis()
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

/** Highest count first, and between equal counts the one jumped most recently */
function highest<T extends { result: SpeedResultDoc, count: number }> (candidates: readonly T[]): T | undefined {
  return candidates.reduce<T | undefined>((best, candidate) => {
    if (best == null) return candidate
    if (candidate.count !== best.count) return candidate.count > best.count ? candidate : best
    return recordedMillis(candidate.result) > recordedMillis(best.result) ? candidate : best
  }, undefined)
}

/**
 * An athlete's best total and best own leg in each event they have a score in,
 * in the order the events are listed. A score against a custom event has no
 * event definition to rank it under, so those are left out.
 */
export function bestsOf (
  results: readonly SpeedResultDoc[],
  eventDefinitions: readonly EventDefinitionDoc[],
  athlete: SpeedAthlete
): SpeedPersonalBest[] {
  const byEvent = new Map<string, SpeedResultDoc[]>()
  for (const result of results) {
    if (result.excludedFromPersonalBests || result.eventDefinitionId == null) continue
    const forEvent = byEvent.get(result.eventDefinitionId)
    if (forEvent) forEvent.push(result)
    else byEvent.set(result.eventDefinitionId, [result])
  }

  return eventDefinitions.flatMap(eventDefinition => {
    const forEvent = byEvent.get(eventDefinition.id) ?? []
    const total = highest(forEvent.map(result => ({ result, count: result.count })))
    if (!total) return []

    const ownSegment = highest(forEvent
      .filter(result => participantOf(result, athlete)?.segmentIndex != null)
      .map(result => segmentResultOf(result, athlete, eventDefinition))
      // a leg the score does not split is no showing of its own to rank
      .filter(segmentResult => segmentResult.segment != null))

    return [{ eventDefinition, total: total.result, ...(ownSegment ? { ownSegment } : {}) }]
  })
}
