import * as Sentry from '@sentry/node'
import { CLOUD_RUN_EXECUTION, JOB_SCHEDULE } from '../config.js'
import { logger } from '../services/logger.js'

/**
 * Runs a job as a root span in a new trace, checked in to the Sentry cron
 * monitor `slug` when `JOB_SCHEDULE` is set, and exits once Sentry has flushed.
 * The job fails by throwing.
 */
export function runJob (slug: string, job: () => Promise<void>) {
  const monitorConfig = JOB_SCHEDULE
    ? { schedule: { type: 'crontab', value: JOB_SCHEDULE }, timezone: 'Etc/UTC', checkinMargin: 5, isolateTrace: true } as const
    : undefined

  async function run () {
    await Sentry.startSpan({
      name: slug,
      op: 'job',
      attributes: CLOUD_RUN_EXECUTION ? { 'cloud_run.execution': CLOUD_RUN_EXECUTION } : {}
    }, job)
  }

  Sentry.withMonitor(slug, run, monitorConfig)
    .then(() => 0, err => {
      logger.error(err)
      Sentry.captureException(err)
      return 1
    })
    .then(async code => {
      await Sentry.flush(2000)
      process.exit(code)
    })
    .catch(() => { process.exit(1) })
}
