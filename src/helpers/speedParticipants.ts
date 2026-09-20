import { FieldValue } from '@google-cloud/firestore'

import { NotFoundError, ValidationError } from '../errors.js'

import type { GroupMemberDoc, SpeedParticipant, SpeedResultDoc } from '../store/schema.js'

/** Everything the queries read. Derived from the participants, never sent. */
export type DerivedParticipants = Pick<SpeedResultDoc,
'participants' | 'athleteMemberIds' | 'soleAthleteMemberId' | 'athleteUserIds' | 'soleAthleteUserId' | 'needsParticipants' | 'constellationKey'
>

/** Exactly one athlete, with no leg of their own, competed the whole thing */
function wholeResult (participants: readonly SpeedParticipant[]) {
  return participants.length === 1 && participants[0].segmentIndex == null
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

/** A score outside a group is its creator's own */
export function ownParticipants (creatorId: string): DerivedParticipants {
  return {
    athleteMemberIds: [],
    athleteUserIds: [creatorId],
    soleAthleteUserId: creatorId,
    needsParticipants: false,
    constellationKey: ''
  }
}

export function deriveParticipants (
  participants: readonly SpeedParticipant[],
  members: Map<string, GroupMemberDoc>
): DerivedParticipants {
  const memberIds = [...new Set(participants.map(participant => participant.memberId))].sort((a, b) => a.localeCompare(b))
  const userOf = (memberId: string) => members.get(memberId)?.userId
  const sole = wholeResult(participants) ? participants[0].memberId : undefined

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
    ...(sole != null ? { soleAthleteMemberId: sole } : {}),
    athleteUserIds: memberIds.map(userOf).filter(userId => userId != null),
    ...(sole != null && userOf(sole) != null ? { soleAthleteUserId: userOf(sole) } : {}),
    needsParticipants: participants.length === 0,
    constellationKey: memberIds.join('|')
  }
}

/**
 * `updateOnePartial` merges, so a derivation that no longer has a field has to
 * say so rather than leave the old value in place.
 */
export function participantUpdate (derived: DerivedParticipants) {
  const clear = FieldValue.delete() as unknown as undefined
  return {
    ...derived,
    participants: derived.participants ?? clear,
    soleAthleteMemberId: derived.soleAthleteMemberId ?? clear,
    soleAthleteUserId: derived.soleAthleteUserId ?? clear
  }
}
