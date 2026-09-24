import { Kind } from 'graphql'
import { InsufficientScopeError } from '../errors.js'
import { refusing } from '../helpers/apiClientMiddleware.js'
import { describeScopeRequirement, scopeViolations } from '../helpers/scopes.js'

import type { ApolloServerPlugin } from '@apollo/server'
import type { DocumentNode, OperationDefinitionNode, SelectionSetNode } from 'graphql'
import type { ApolloContext } from '../apollo.js'
import type { ScopeRequirements } from '../helpers/scopes.js'

/** The root fields an operation selects, through the fragments at its root */
function rootFields (document: DocumentNode, operation: OperationDefinitionNode) {
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

/**
 * Refuses an operation selecting anything its client lacks the scopes for,
 * as a whole and before anything runs. Also tells the usage record what the
 * operation was.
 */
export function scopesPlugin (requirements: ScopeRequirements): ApolloServerPlugin<ApolloContext> {
  return {
    async requestDidStart ({ contextValue: { res } }) {
      // until an operation says which root fields
      res.locals.usage = { ...res.locals.usage, target: '/graphql' }
      return {
        async didResolveOperation ({ schema, document, operation, operationName, contextValue }) {
          if (operation == null) return
          const { req, res, client, logger } = contextValue

          const fields = rootFields(document, operation)
          res.locals.usage = {
            ...res.locals.usage,
            kind: operation.operation,
            operation: operationName ?? null,
            // introspection alone selects no root field of ours
            target: fields.length > 0 ? fields.join(',') : '__schema'
          }

          const violations = scopeViolations(schema, requirements, document, operation, client.scopes)
          if (violations.length === 0) return

          const detail = violations.map(({ field, requires }) => `${field} (${describeScopeRequirement(requires)})`).join(', ')
          const error = new InsufficientScopeError(`${client.name} lacks the scopes for ${detail}`, {
            extensions: { client: client.id, fields: violations.map(({ field, requires }) => ({ field, requires })) }
          })
          // Apollo answers with what is thrown here
          if (refusing(req, res, 'INSUFFICIENT_SCOPE', error, { logger })) throw error
        }
      }
    }
  }
}
