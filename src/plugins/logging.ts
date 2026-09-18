import type { ApolloServerPlugin } from '@apollo/server'
import type { ApolloContext } from '../apollo.js'
import { logger } from '../services/logger.js'

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
