import './tracing'

import { PORT } from './config'
import { initApollo } from './apollo'
import { logger } from './services/logger'
import { allowedOrigins } from './services/cors'
import { muxWebhookHandler } from './services/muxWebhook'
import express from 'express'
import cors from 'cors'
import http from 'node:http'

const app = express()
const httpServer = http.createServer(app)

app.disable('x-powered-by')

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  allowedHeaders: ['content-type', 'authorization', 'sentry-trace', 'baggage'],
  maxAge: 7200
}))

// Mux signs the raw request body, so this has to be mounted before any body
// parser turns it into an object
app.post('/webhooks/mux', express.raw({ type: 'application/json' }), muxWebhookHandler)

initApollo(httpServer)
  .then(async middleware => {
    app.use(['/graphql', /^\/$/], express.json(), middleware)

    await new Promise<void>(resolve => httpServer.listen({ port: PORT }, resolve))
    logger.info(`Server ready at http://localhost:${PORT}/graphql`)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
