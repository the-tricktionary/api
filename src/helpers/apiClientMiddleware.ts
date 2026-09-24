import cors from 'cors'
import { ACCESS_CONTROL } from '../config.js'
import { AuthenticationError, AuthorizationError, InsufficientScopeError } from '../errors.js'
import { Scope } from '../generated/graphql.js'
import { allowsOrigin, ANONYMOUS, apiClientByKey, apiClientRegistry } from '../services/apiClients.js'
import { sendError } from './httpErrors.js'
import { requestLogger } from './requestLogger.js'
import { describeScopeRequirement, holdsScopes } from './scopes.js'

import type { CorsOptions } from 'cors'
import type { Request, RequestHandler, Response } from 'express'
import type { GraphQLError } from 'graphql'
import type Pino from 'pino'
import type { ApiClient } from '../services/apiClients.js'
import type { ScopeRequirement } from './scopes.js'

/** `Authorization` carries the signed in user's ID token */
export const API_KEY_HEADER = 'Api-Key'

export type DeniedReason = 'UNKNOWN_API_KEY' | 'ORIGIN_NOT_ALLOWED' | 'SIGN_IN_NOT_ALLOWED' | 'INSUFFICIENT_SCOPE'

declare module 'express-serve-static-core' {
  interface Request {
    /** Missing only while a key nobody holds is denied */
    apiClient?: ApiClient
  }
}

export function apiClientOf (req: Request): ApiClient {
  if (req.apiClient == null) throw new Error('The API client middleware has not run for this request')
  return req.apiClient
}

/**
 * Whether access control denies the request. `ACCESS_CONTROL=report` logs
 * the denial and lets the request through instead. The usage record keeps
 * the first reason either way.
 */
export function denies (req: Request, res: Response, reason: DeniedReason, error: GraphQLError, { logger }: { logger: Pino.Logger }) {
  res.locals.usage = { ...res.locals.usage, denied: res.locals.usage?.denied ?? reason }
  if (ACCESS_CONTROL === 'enforce') return true
  logger.warn({ client: req.apiClient?.id, reason }, `Letting through what access control denies: ${error.message}`)
  return false
}

/** `denies`, answering the request with the error. True when it was denied. */
function deny (req: Request, res: Response, reason: DeniedReason, error: GraphQLError, { logger }: { logger: Pino.Logger }) {
  if (!denies(req, res, reason, error, { logger })) return false
  sendError(req, res, error, { logger })
  return true
}

const identifyApiClient: RequestHandler = async (req, res, next) => {
  res.vary(API_KEY_HEADER)
  let client
  try {
    client = await apiClientByKey(req.get(API_KEY_HEADER))
  } catch (err) {
    sendError(req, res, err, { logger: requestLogger(req) })
    return
  }
  req.apiClient = client ?? undefined
  next()
}

/**
 * The client's origins. A preflight carries no key, so it gets every
 * client's origins, and so does a key nobody holds, so the page can read the
 * error.
 */
function corsOptions (req: Request, callback: (err: Error | null, options?: CorsOptions) => void) {
  const optionsFor = (origins: readonly RegExp[]): CorsOptions => ({
    origin: [...origins],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', API_KEY_HEADER.toLowerCase(), 'sentry-trace', 'baggage'],
    maxAge: 7200
  })

  if (req.method !== 'OPTIONS' && req.apiClient != null && ACCESS_CONTROL === 'enforce') {
    callback(null, optionsFor(req.apiClient.origins))
    return
  }
  apiClientRegistry()
    .then(registry => { callback(null, optionsFor(registry.origins)) })
    .catch(callback)
}

const checkApiClient: RequestHandler = (req, res, next) => {
  const logger = requestLogger(req)

  if (req.apiClient == null) {
    if (deny(req, res, 'UNKNOWN_API_KEY', new AuthenticationError('Nobody holds that API key, or it has been revoked'), { logger })) return
    req.apiClient = ANONYMOUS
  }
  const client = req.apiClient

  // only browsers send it, and they can't forge it
  const origin = req.get('origin')
  if (origin != null && !allowsOrigin(client, origin)) {
    const message = client === ANONYMOUS
      ? `A request from ${origin} needs an API key that may be used from there`
      : `The API key of ${client.name} may not be used from ${origin}`
    if (deny(req, res, 'ORIGIN_NOT_ALLOWED', new AuthorizationError(message), { logger })) return
  }

  if (req.get('authorization') && !client.scopes.has(Scope.Account)) {
    const error = new AuthorizationError(`Users only sign in through the Tricktionary's own apps, ${client.name} may not act as one`)
    if (deny(req, res, 'SIGN_IN_NOT_ALLOWED', error, { logger })) return
  }

  next()
}

/** Identifies the client, answers CORS for it and denies what it may not do. See the README. */
export const apiClientMiddleware = [identifyApiClient, cors(corsOptions), checkApiClient]

/** `@requiresScopes` for a plain HTTP route */
export function requireScopes (requirement: ScopeRequirement): RequestHandler {
  return (req, res, next) => {
    const client = apiClientOf(req)
    if (!holdsScopes(client.scopes, requirement)) {
      const error = new InsufficientScopeError(`${client.name} lacks the scopes for ${req.path}. ${describeScopeRequirement(requirement)}`, {
        extensions: { client: client.id, fields: [{ field: req.path, requires: requirement }] }
      })
      if (deny(req, res, 'INSUFFICIENT_SCOPE', error, { logger: requestLogger(req) })) return
    }
    next()
  }
}
