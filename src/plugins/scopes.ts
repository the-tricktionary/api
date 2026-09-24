import { InsufficientScopeError } from '../errors.js'
import { recordDenial } from '../helpers/apiClientMiddleware.js'
import { describeScopeRequirement, scopeViolations } from '../helpers/scopes.js'

import type { ApolloServerPlugin } from '@apollo/server'
import type { ApolloContext } from '../apollo.js'
import type { ScopeRequirements } from '../helpers/scopes.js'

/** Denies an operation selecting anything its client lacks the scopes for, as a whole and before anything runs */
export function scopesPlugin (requirements: ScopeRequirements): ApolloServerPlugin<ApolloContext> {
  return {
    async requestDidStart () {
      return {
        async didResolveOperation ({ schema, document, operation, contextValue: { res, client } }) {
          if (operation == null) return
          const violations = scopeViolations(schema, requirements, document, operation, client.scopes)
          if (violations.length === 0) return

          const detail = violations.map(({ field, requires }) => `${field} (${describeScopeRequirement(requires)})`).join(', ')
          const error = new InsufficientScopeError(`${client.name} lacks the scopes for ${detail}`, {
            extensions: { client: client.id, fields: violations }
          })
          recordDenial(res, 'INSUFFICIENT_SCOPE')
          throw error
        }
      }
    }
  }
}
