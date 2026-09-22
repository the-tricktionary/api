import { Timestamp } from '@google-cloud/firestore'
import { RateLimitError } from '../errors.js'

import type { DataSources } from '../store/firestoreDataSource.js'
import type { UserDoc } from '../store/schema.js'

/** The window both daily limits roll over */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000

/** Every count a trick submission is held to, per trust status of the submitter */
export const SUBMISSION_LIMITS = {
  /** Submissions of one user that nobody has reviewed yet */
  pendingPerUser: { regular: 5, trusted: 50 },
  /** Submissions of one user in the last 24 hours */
  dailyPerUser: { regular: 5, trusted: 50 },
  /** Submissions of every user in the last 24 hours, the two pools are counted separately */
  dailyGlobal: { regular: 50, trusted: 500 }
} as const

/** The longest video a submission may carry, in seconds */
export const MAX_SUBMISSION_VIDEO_SECONDS = 90

/** Trust is earned by having submissions accepted, and lost by having as many rejected */
export function isTrustedSubmitter (user: UserDoc) {
  const accepted = user.submissionStats?.accepted ?? 0
  const rejected = user.submissionStats?.rejected ?? 0
  return accepted >= 2 && rejected < accepted
}

/** Throws a `RateLimitError` when the submitter, or everyone together, has reached a limit */
export async function assertWithinSubmissionLimits (userId: UserDoc['id'], trusted: boolean, { dataSources }: { dataSources: DataSources }) {
  const pool = trusted ? 'trusted' : 'regular'
  const since = Timestamp.fromMillis(Date.now() - DAILY_WINDOW_MS)

  const [pending, daily, dailyGlobal] = await Promise.all([
    dataSources.trickSubmissions.countPendingByUser(userId),
    dataSources.trickSubmissions.countByUserSince(userId, since),
    dataSources.trickSubmissions.countByTrustSince(trusted, since)
  ])

  const pendingLimit = SUBMISSION_LIMITS.pendingPerUser[pool]
  if (pending >= pendingLimit) {
    throw new RateLimitError(
      `You have ${pendingLimit} submissions waiting to be reviewed, which is as many as you may have at once`,
      { extensions: { scope: 'user', limit: pendingLimit } }
    )
  }

  const dailyLimit = SUBMISSION_LIMITS.dailyPerUser[pool]
  if (daily >= dailyLimit) {
    throw new RateLimitError(
      `You have submitted ${dailyLimit} tricks in the last day, which is as many as you may, try again later`,
      { extensions: { scope: 'user', limit: dailyLimit } }
    )
  }

  const dailyGlobalLimit = SUBMISSION_LIMITS.dailyGlobal[pool]
  if (dailyGlobal >= dailyGlobalLimit) {
    throw new RateLimitError(
      'The Tricktionary has taken as many submissions as it can in a day, try again later',
      { extensions: { scope: 'global', limit: dailyGlobalLimit } }
    )
  }
}
