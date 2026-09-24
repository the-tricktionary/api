import type { ApolloServerPlugin } from '@apollo/server'
import type { ApolloContext } from '../apollo.js'
import { rootFields } from '../helpers/usage.js'
import { logger } from '../services/logger.js'

const loggingPlugin: ApolloServerPlugin<ApolloContext> = {
  async requestDidStart ({ contextValue: { res } }) {
    res.locals.usage = { ...res.locals.usage, target: '/graphql' }
    return {
      async didResolveOperation ({ document, operation, operationName }) {
        logger.trace({ operationName }, 'resolved operation')
        if (operation == null) return
        const fields = rootFields(document, operation)
        res.locals.usage = {
          ...res.locals.usage,
          kind: operation.operation,
          operation: operationName ?? null,
          // introspection alone selects none
          target: fields.length > 0 ? fields.join(',') : '__schema'
        }
      }
    }
  }
}

export default loggingPlugin
