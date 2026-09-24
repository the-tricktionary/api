import { ApolloServer, type BaseContext } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl'
import { expressMiddleware, type ExpressContextFunctionArgument } from '@as-integrations/express5'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { unwrapResolverError } from '@apollo/server/errors'
import type Pino from 'pino'
import type { Server } from 'node:http'

import { SENTRY_DSN } from './config.js'
import typeDefs from './schema.js'
import { rootResolver as resolvers } from './resolvers/rootResolver.js'
import sentryPlugin from './plugins/sentry.js'
import loggingPlugin from './plugins/logging.js'
import { scopesPlugin } from './plugins/scopes.js'
import { userFromAuthorizationHeader } from './services/authentication.js'
import { allowUser } from './services/permissions.js'
import { isServerError, toCustomError } from './helpers/httpErrors.js'
import { logger } from './services/logger.js'
import { requestLogger } from './helpers/requestLogger.js'
import { apiClientOf } from './helpers/apiClientMiddleware.js'
import { assertRootFieldsScoped, describeScopes, scopeRequirements } from './helpers/scopes.js'
import { createDataSources, dataSourceCache } from './store/firestoreDataSource.js'

import type { DataSources } from './store/firestoreDataSource.js'
import type { UserDoc } from './store/schema.js'
import type { ApiClient } from './services/apiClients.js'

export async function initApollo (httpServer: Server) {
  const executableSchema = makeExecutableSchema({ typeDefs, resolvers })
  const requirements = scopeRequirements(executableSchema)
  assertRootFieldsScoped(executableSchema, requirements)
  const schema = describeScopes(executableSchema)

  const plugins = [
    loggingPlugin,
    scopesPlugin(requirements),
    ApolloServerPluginDrainHttpServer({ httpServer }),
    ApolloServerPluginCacheControl({ })
  ]

  if (SENTRY_DSN != null) {
    plugins.push(sentryPlugin)
  }

  const server = new ApolloServer({
    schema,
    plugins,
    cache: dataSourceCache,
    logger: logger.child({ name: 'apollo-server' }),
    introspection: true,
    formatError (formattedError, wrappedOriginal) {
      const err = toCustomError(unwrapResolverError(wrappedOriginal))
      if (isServerError(err)) logger.error(err)
      else logger.info(err)
      return err
    }
  })

  await server.start()

  return expressMiddleware(server, {
    async context (context: ExpressContextFunctionArgument): Promise<ApolloContext> {
      const dataSources = createDataSources()

      const childLogger = requestLogger(context.req)
      const authHeader = context.req.get('authorization')
      const user = await userFromAuthorizationHeader(authHeader, { logger: childLogger, dataSources })

      return {
        ...context,
        dataSources,
        client: apiClientOf(context.req),
        user,
        allowUser: allowUser(user, { logger: childLogger }),
        logger: childLogger
      }
    }
  })
}

export interface TrickContext {
  dataSources: DataSources
  client: ApiClient
  user?: UserDoc
  allowUser: ReturnType<typeof allowUser>
  logger: Pino.Logger
}

export type ApolloContext = ExpressContextFunctionArgument & BaseContext & TrickContext
