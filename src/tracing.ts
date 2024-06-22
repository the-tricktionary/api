import * as Sentry from '@sentry/node'
import { SENTRY_DSN, GITHUB_SHA } from './config'
import { logger } from './services/logger'

if (SENTRY_DSN != null) {
  Sentry.init({
    dsn: SENTRY_DSN,
    integrations: [
      Sentry.httpIntegration(),
      Sentry.nativeNodeFetchIntegration(),
      Sentry.graphqlIntegration(),
      Sentry.anrIntegration(),
      ...Sentry.getAutoPerformanceIntegrations()
    ],
    release: `tricktionary-api@${GITHUB_SHA}`,
    tracesSampleRate: 1.0
  });

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
