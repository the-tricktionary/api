import './tracing'

import { PORT } from './config'
import { initApollo } from './apollo'
import { logger } from './services/logger'
import express from 'express'
import cors from 'cors'
import http from 'node:http'
import bodyParser from 'body-parser'

const app = express()
const httpServer = http.createServer(app)

app.disable('x-powered-by')

app.use(cors({
  origin: [
    /(^https?:\/\/|\.)the-tricktionary\.(com)(:\d+)?$/,
    /^https:\/\/tricktionary-(v4|admin)--.+\.web\.app$/,
    /^https?:\/\/localhost(:\d+)?$/
  ],
  credentials: true,
  allowedHeaders: ['content-type', 'authorization', 'sentry-trace', 'baggage'],
  maxAge: 7200
}))

initApollo(httpServer)
  .then(async middleware => {
    app.use(['/graphql', /^\/$/], bodyParser.json(), middleware)

    await new Promise<void>(resolve => httpServer.listen({ port: PORT }, resolve))
    logger.info(`Server ready at http://localhost:${PORT}/graphql`)
  })
  .catch(err => {
    logger.error(err)
    process.exit(1)
  })
