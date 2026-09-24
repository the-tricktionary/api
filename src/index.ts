// Sentry is not imported here: under ESM the loader hooks that instrument a
// module have to be registered before that module is loaded, and every import
// below is loaded before any of this file runs. `tracing` is preloaded with
// node's `--import` flag instead, see the `dev` script and the Dockerfile.
import { PORT } from './config.js'
import { initApollo } from './apollo.js'
import { logger } from './services/logger.js'
import { apiClientMiddleware, requireScopes } from './helpers/apiClientMiddleware.js'
import { Scope } from './generated/graphql.js'
import { muxWebhookHandler } from './routes/muxWebhook.js'
import { sitemapHandler } from './routes/sitemap.js'
import { bookletHandler } from './routes/booklet.js'
import express from 'express'
import http from 'node:http'

const app = express()
const httpServer = http.createServer(app)

app.disable('x-powered-by')

// the API client of every request, CORS and usage, see the README
app.use(apiClientMiddleware)

// Mux signs the raw request body, so this has to be mounted before any body
// parser turns it into an object
app.post('/webhooks/mux', express.raw({ type: 'application/json' }), muxWebhookHandler)

// Reached through the public site's Firebase Hosting rewrites, not directly
app.get('/sitemap.xml', requireScopes([[Scope.Public]]), sitemapHandler)
app.get('/booklets/tricks.pdf', requireScopes([[Scope.Public]]), bookletHandler)

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
