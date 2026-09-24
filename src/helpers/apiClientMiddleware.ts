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

/** Not `Authorization`, which carries the signed in user's ID token */
export const API_KEY_HEADER = 'Api-Key'

export type DeniedReason = 'UNKNOWN_API_KEY' | 'ORIGIN_NOT_ALLOWED' | 'SIGN_IN_NOT_ALLOWED' | 'INSUFFICIENT_SCOPE'

/** One per request, logged when the response is done and counted by a log-based metric */
export interface UsageRecord {
  /** Null for a key nobody holds */
  client: string | null
  /** A GraphQL operation's type, `http` for anything else */
  kind: 'query' | 'mutation' | 'subscription' | 'http'
  /** A GraphQL operation's name, as the client named it */
  operation: string | null
  /**
   * The root fields a GraphQL operation selects, sorted and comma separated,
   * `/graphql` for a GraphQL request without an operation to run, the route
   * of anything else, and null for a path no route serves
   */
  target: string | null
  status: number
  /** Why the request was refused, or would have been under `ACCESS_CONTROL=report` */
  denied: DeniedReason | null
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set before any route runs, it's only missing while a key nobody holds is refused */
    apiClient?: ApiClient
  }
  interface Locals {
    usage?: Partial<UsageRecord>
  }
}

/** The request's client, once `apiClientMiddleware` has let it through */
export function apiClientOf (req: Request): ApiClient {
  if (req.apiClient == null) throw new Error('The API client middleware has not run for this request')
  return req.apiClient
}

/**
 * Whether to refuse what access control would refuse: yes, unless under
 * `ACCESS_CONTROL=report`, which logs it and lets it through. The usage
 * record gets the reason either way.
 */
export function refusing (req: Request, res: Response, reason: DeniedReason, error: GraphQLError, { logger }: { logger: Pino.Logger }) {
  // the first, where enforcing would have stopped
  res.locals.usage = { ...res.locals.usage, denied: res.locals.usage?.denied ?? reason }
  if (ACCESS_CONTROL === 'enforce') return true
  logger.warn({ client: req.apiClient?.id, reason }, `Letting through what access control would refuse: ${error.message}`)
  return false
}

/** `refusing`, answering the request with the error when it does. True when the request was refused. */
function refuse (req: Request, res: Response, reason: DeniedReason, error: GraphQLError, { logger }: { logger: Pino.Logger }) {
  if (!refusing(req, res, reason, error, { logger })) return false
  sendError(req, res, error, { logger })
  return true
}

/** Finds the client by its key and logs the request's usage once it's answered */
const identifyApiClient: RequestHandler = async (req, res, next) => {
  // what a response holds depends on the client
  res.vary(API_KEY_HEADER)

  res.on('finish', () => {
    // a preflight is part of the request it precedes
    if (req.method === 'OPTIONS') return
    const usage: UsageRecord = {
      client: req.apiClient?.id ?? null,
      kind: 'http',
      operation: null,
      // the route rather than the path, which is anything anyone asks for
      target: (req.route as { path?: string } | undefined)?.path ?? null,
      denied: null,
      ...res.locals.usage,
      status: res.statusCode
    }
    requestLogger(req).info({ usage }, 'API usage')
  })

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
 * CORS as the client allows it. A preflight carries the names of the headers
 * but not the key, so it is answered for every origin some client may call
 * from, and so is a request with a key nobody holds, so that the browser lets
 * the page read the error.
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

/**
 * Refuses a key nobody holds, a browser origin the client may not call from,
 * and a signed in user from a client that may not sign users in
 */
const checkApiClient: RequestHandler = (req, res, next) => {
  const logger = requestLogger(req)

  if (req.apiClient == null) {
    if (refuse(req, res, 'UNKNOWN_API_KEY', new AuthenticationError('Nobody holds that API key, or it has been revoked'), { logger })) return
    req.apiClient = ANONYMOUS
  }
  const client = req.apiClient

  // only browsers send it, and they can't be made to lie about it
  const origin = req.get('origin')
  if (origin != null && !allowsOrigin(client, origin)) {
    const message = client === ANONYMOUS
      ? `A request from ${origin} needs an API key that may be used from there`
      : `The API key of ${client.name} may not be used from ${origin}`
    if (refuse(req, res, 'ORIGIN_NOT_ALLOWED', new AuthorizationError(message), { logger })) return
  }

  if (req.get('authorization') && !client.scopes.has(Scope.Account)) {
    const error = new AuthorizationError(`Users only sign in through the Tricktionary's own apps, ${client.name} may not act as one`)
    if (refuse(req, res, 'SIGN_IN_NOT_ALLOWED', error, { logger })) return
  }

  next()
}

/**
 * Runs before every route: identifies the client by the `Api-Key` header,
 * answers CORS for it and refuses what it may not do. See the README.
 */
export const apiClientMiddleware = [identifyApiClient, cors(corsOptions), checkApiClient]

/** `@requiresScopes` for a plain HTTP route */
export function requireScopes (requirement: ScopeRequirement): RequestHandler {
  return (req, res, next) => {
    const client = apiClientOf(req)
    if (!holdsScopes(client.scopes, requirement)) {
      const error = new InsufficientScopeError(`${client.name} lacks the scopes for ${req.path}. ${describeScopeRequirement(requirement)}`, {
        extensions: { client: client.id, fields: [{ field: req.path, requires: requirement }] }
      })
      if (refuse(req, res, 'INSUFFICIENT_SCOPE', error, { logger: requestLogger(req) })) return
    }
    next()
  }
}
