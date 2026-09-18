/**
 * Preloaded with node's `--import` flag rather than imported from `index`, so
 * that `Sentry.init` runs before the libraries it instruments are loaded.
 */
import * as Sentry from '@sentry/node'
import { SENTRY_DSN, GITHUB_SHA } from './config.js'
import { logger } from './services/logger.js'

if (SENTRY_DSN != null) {
  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.graphqlIntegration(),
      ...Sentry.getAutoPerformanceIntegrations()
    ],
    release: `tricktionary-api@${GITHUB_SHA}`,
    tracesSampleRate: 1.0
  })

  process.on('SIGTERM', () => {
    Sentry.close(2000)
      .then(async () => {
        logger.debug('Sentry shut down successfully')
      })
      .catch(async err => {
        logger.error({ err }, 'Error shutting down Sentry')
      })
      .finally(() => {
        process.exit()
      })
  })
}
