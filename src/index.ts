import '@sentry/node'
import '@sentry/tracing'
import { PORT } from './config'
import { server } from './apollo'
import { logger } from './services/logger'

server.listen(PORT)
  .then(({ url }) => {
    logger.info(`Server ready at ${url}`)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
