import * as Sentry from '@sentry/node'
import { GraphQLError } from 'graphql'
import z from 'zod'
import { fromZodError } from 'zod-validation-error'
import { UnexpectedError, ValidationError } from '../errors.js'

import type { Request, Response } from 'express'
import type Pino from 'pino'

/**
 * Any error as one of ours: our errors as they are, a zod error as a
 * validation error, and anything else wrapped as unexpected. The GraphQL
 * error formatter and the plain HTTP routes both answer with these.
 */
export function toCustomError (error: unknown): GraphQLError {
  if (error instanceof GraphQLError) return error
  if (error instanceof z.ZodError) {
    return new ValidationError(fromZodError(error).message, { extensions: { issues: error.issues } })
  }
  return new UnexpectedError(error instanceof Error ? error : new Error(String(error)))
}

function httpStatus (err: GraphQLError) {
  const http = err.extensions.http as { status?: unknown } | undefined
  return typeof http?.status === 'number' ? http.status : 500
}

/** Ours rather than a client's mistake: logged as an error and reported, where a mistake is only logged */
export function isServerError (err: GraphQLError) {
  return httpStatus(err) >= 500
}

function escapeHtml (text: string) {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

function errorPage (err: GraphQLError, status: number) {
  const code = typeof err.extensions.code === 'string' ? err.extensions.code : 'ERROR'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${status} – the Tricktionary</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; color: #111; background: #fff; }
    main { max-width: 40rem; margin: 0 auto; }
    h1 { color: #fe3500; }
    code { background: #eee; padding: 0.1em 0.3em; border-radius: 0.2em; }
    @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } code { background: #333; } }
  </style>
</head>
<body>
  <main>
    <h1>${status}</h1>
    <p>${escapeHtml(err.message)}</p>
    <p><code>${escapeHtml(code)}</code></p>
  </main>
</body>
</html>
`
}

/**
 * Answers a plain HTTP route with an error, converted to one of ours: as JSON
 * shaped like a GraphQL response, or as a small page for a browser that
 * asked for HTML.
 */
export function sendError (req: Request, res: Response, error: unknown, { logger }: { logger: Pino.Logger }) {
  const err = toCustomError(error)
  const status = httpStatus(err)

  if (isServerError(err)) {
    logger.error(err)
    Sentry.captureException(err)
  } else {
    logger.info(err)
  }

  if (status === 503) res.set('retry-after', '5')
  res.status(status)
  if (req.accepts(['json', 'html']) === 'html') {
    res.type('html').send(errorPage(err, status))
  } else {
    res.json({ errors: [{ message: err.message, extensions: err.extensions }] })
  }
}
