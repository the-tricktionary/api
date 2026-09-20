// Sentry is not imported here: under ESM the loader hooks that instrument a
// module have to be registered before that module is loaded, and every import
// below is loaded before any of this file runs. `tracing` is preloaded with
// node's `--import` flag instead, see the `dev` script and the Dockerfile.
import { PORT } from './config.js'
import { initApollo } from './apollo.js'
import { logger } from './services/logger.js'
import { allowedOrigins } from './helpers/cors.js'
import { muxWebhookHandler } from './routes/muxWebhook.js'
import { sitemapHandler } from './routes/sitemap.js'
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

// Reached through the public site's Firebase Hosting rewrite, not directly
app.get('/sitemap.xml', sitemapHandler)

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
