import type { ApolloServerPlugin } from '@apollo/server'
import type { ApolloContext } from '../apollo'
import { logger } from '../services/logger'

const loggingPlugin: ApolloServerPlugin<ApolloContext> = {
  async requestDidStart (_) {
    return {
      async didResolveOperation ({ operationName }) {
        logger.trace({ operationName }, 'resolved operation')
      }
    }
  }
}

export default loggingPlugin
