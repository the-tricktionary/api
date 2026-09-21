import { byEventOrder } from './eventDefinitions.js'
import { analysisOf } from './speedMarks.js'
import { constellationMemberIds } from './speedParticipants.js'

import type { DataSources } from '../store/firestoreDataSource.js'
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

function recordedMillis (result: SpeedResultDoc) {
  return (result.recordedAt ?? result.createdAt).toMillis()
}

/** The first `limit` of the union of lists that each hold their own newest `limit` results */
export function mergeNewest (lists: ReadonlyArray<readonly SpeedResultDoc[]>, limit?: number | null): SpeedResultDoc[] {
  const byId = new Map<string, SpeedResultDoc>()
  for (const result of lists.flat()) byId.set(result.id, result)
  const merged = [...byId.values()].sort((a, b) => recordedMillis(b) - recordedMillis(a))
  return limit ? merged.slice(0, limit) : merged
}

/** The best score in each predefined event, in the order the events are listed */
export async function personalBests (best: (eventDefinitionId: string) => Promise<SpeedResultDoc | undefined>, dataSources: DataSources) {
  const eventDefinitions = (await dataSources.eventDefinitions.findManyByQuery(c => c, { ttl: 3600 }))
    .sort(byEventOrder)
  const bests = await Promise.all(eventDefinitions.map(async eventDefinition => await best(eventDefinition.id)))
  return bests.filter(result => result != null)
}

export function segmentResultOf (result: SpeedResultDoc, memberId: string, eventDefinition: EventDefinitionDoc): SpeedSegmentResult {
  const segmentIndex = result.participants?.find(participant => participant.memberId === memberId)?.segmentIndex
  const analysis = analysisOf(result, eventDefinition)
  const segment = segmentIndex != null ? analysis?.segments[segmentIndex] : undefined
  if (segment) return { result, segment, count: segment.count, stepsPerSecond: segment.stepsPerSecond }
  return { result, count: result.count, ...(analysis ? { stepsPerSecond: analysis.stepsPerSecond } : {}) }
}

/**
 * Commonest first, scores nobody has been assigned to yet are no constellation.
 * Each constellation's members keep the order `members` came in.
 */
export function groupConstellations (results: readonly SpeedResultDoc[], members: readonly GroupMemberDoc[]): GroupConstellation[] {
  const counts = new Map<string, number>()
  for (const result of results) {
    if (!result.constellationKey) continue
    counts.set(result.constellationKey, (counts.get(result.constellationKey) ?? 0) + 1)
  }

  return [...counts]
    .sort(([keyA, countA], [keyB, countB]) => countB - countA || keyA.localeCompare(keyB))
    .map(([key, resultCount]) => {
      const memberIds = new Set(constellationMemberIds(key))
      return { key, members: members.filter(member => memberIds.has(member.id)), resultCount }
    })
}
