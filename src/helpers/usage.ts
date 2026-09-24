import { Kind } from 'graphql'
import { requestLogger } from './requestLogger.js'

import type { RequestHandler } from 'express'
import type { DocumentNode, OperationDefinitionNode, SelectionSetNode } from 'graphql'
import type { DeniedReason } from './apiClientMiddleware.js'

/** One per request, counted by the `api/usage` log-based metric */
export interface UsageRecord {
  /** Null for a key nobody holds */
  client: string | null
  kind: 'query' | 'mutation' | 'subscription' | 'http'
  /** A GraphQL operation's name, as the client sent it */
  operation: string | null
  /**
   * A GraphQL operation's root fields, sorted and comma separated. For
   * anything else the route, null when no route matched.
   */
  target: string | null
  status: number
  denied: DeniedReason | null
}

declare module 'express-serve-static-core' {
  interface Locals {
    usage?: Partial<UsageRecord>
  }
}

/** Logs the request's usage once it's answered, from what the routes put in `res.locals.usage` */
export const logUsage: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    // counted with the request it precedes
    if (req.method === 'OPTIONS') return
    const usage: UsageRecord = {
      client: req.apiClient?.id ?? null,
      kind: 'http',
      operation: null,
      // the route rather than the path keeps the metric's labels bounded
      target: (req.route as { path?: string } | undefined)?.path ?? null,
      denied: null,
      ...res.locals.usage,
      status: res.statusCode
    }
    requestLogger(req).info({ usage }, 'API usage')
  })
  next()
}

/** Through the fragments at the operation's root */
export function rootFields (document: DocumentNode, operation: OperationDefinitionNode) {
  const fields = new Set<string>()
  const collect = (selectionSet: SelectionSetNode) => {
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        if (!selection.name.value.startsWith('__')) fields.add(selection.name.value)
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet)
      } else {
        const fragment = document.definitions.find(definition => definition.kind === Kind.FRAGMENT_DEFINITION && definition.name.value === selection.name.value)
        if (fragment?.kind === Kind.FRAGMENT_DEFINITION) collect(fragment.selectionSet)
      }
    }
  }
  collect(operation.selectionSet)
  return [...fields].sort()
}
