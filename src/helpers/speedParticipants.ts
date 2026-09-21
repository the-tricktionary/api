import { FieldValue } from '@google-cloud/firestore'

import { NotFoundError, ValidationError } from '../errors.js'

import type { GroupMemberDoc, SpeedParticipant, SpeedResultDoc } from '../store/schema.js'

export type DerivedParticipants = Pick<SpeedResultDoc,
'participants' | 'athleteMemberIds' | 'wholeScoreMemberId' | 'athleteUserIds' | 'wholeScoreUserId' | 'needsParticipants' | 'constellationKey'
>

function wholeResult (participants: readonly SpeedParticipant[]) {
  return participants.length === 1 && participants[0].segmentIndex == null
}

/** The set of athletes on a score: distinct member ids, sorted */
export function constellationOf (memberIds: readonly string[]) {
  return [...new Set(memberIds)].sort((a, b) => a.localeCompare(b))
}

export function constellationKey (memberIds: readonly string[]) {
  return constellationOf(memberIds).join('|')
}

export function constellationMemberIds (key: string) {
  return key ? key.split('|') : []
}

export function assertValidParticipants (
  participants: readonly SpeedParticipant[],
  members: Map<string, GroupMemberDoc>,
  segmentCount: number
) {
  if (!participants.length) return

  for (const participant of participants) {
    const member = members.get(participant.memberId)
    if (!member) {
      throw new NotFoundError(`Group member ${participant.memberId} is not in this group`, { extensions: { entity: 'group-member', id: participant.memberId } })
    }
    if (member.observer) {
      throw new ValidationError('An observer does not compete, so they cannot be named on a score')
    }
  }

  const memberIds = participants.map(participant => participant.memberId)
  if (new Set(memberIds).size !== memberIds.length) {
    throw new ValidationError('An athlete can only be named once on a score')
  }

  const legs = participants.filter(participant => participant.segmentIndex != null)
  if (legs.length && legs.length !== participants.length) {
    throw new ValidationError('A score is assigned either as a whole or leg by leg, not a mixture')
  }
  if (!legs.length) {
    if (!wholeResult(participants)) throw new ValidationError('Only one athlete can have competed the whole score')
    return
  }

  const indexes = legs.map(leg => leg.segmentIndex!)
  if (indexes.some(index => index >= segmentCount)) {
    throw new ValidationError(`The event has ${segmentCount} ${segmentCount === 1 ? 'leg' : 'legs'}, so there is nothing to assign beyond that`)
  }
}

export function ownParticipants (creatorId: string): DerivedParticipants {
  return {
    athleteMemberIds: [],
    athleteUserIds: [creatorId],
    wholeScoreUserId: creatorId,
    needsParticipants: false,
    constellationKey: ''
  }
}

export function deriveParticipants (
  participants: readonly SpeedParticipant[],
  members: Map<string, GroupMemberDoc>
): DerivedParticipants {
  const memberIds = constellationOf(participants.map(participant => participant.memberId))
  const userOf = (memberId: string) => members.get(memberId)?.userId
  const whole = wholeResult(participants) ? participants[0].memberId : undefined

  return {
    ...(participants.length
      ? {
          participants: participants.map(participant => ({
            ...(participant.segmentIndex != null ? { segmentIndex: participant.segmentIndex } : {}),
            memberId: participant.memberId
          }))
        }
      : {}),
    athleteMemberIds: memberIds,
    ...(whole != null ? { wholeScoreMemberId: whole } : {}),
    athleteUserIds: memberIds.map(userOf).filter(userId => userId != null),
    ...(whole != null && userOf(whole) != null ? { wholeScoreUserId: userOf(whole) } : {}),
    needsParticipants: participants.length === 0,
    constellationKey: constellationKey(memberIds)
  }
}

/** `updateOnePartial` merges, so the fields a derivation no longer has must be deleted */
export function participantUpdate (derived: DerivedParticipants) {
  const clear = FieldValue.delete() as unknown as undefined
  return {
    ...derived,
    participants: derived.participants ?? clear,
    wholeScoreMemberId: derived.wholeScoreMemberId ?? clear,
    wholeScoreUserId: derived.wholeScoreUserId ?? clear
  }
}
