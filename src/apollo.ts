import { ApolloServer, type BaseContext } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl'
import { expressMiddleware, type ExpressContextFunctionArgument } from '@as-integrations/express5'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { fromZodError } from 'zod-validation-error'
import { unwrapResolverError } from '@apollo/server/errors'
import z from 'zod'
import { GraphQLError } from 'graphql'
import type Pino from 'pino'
import type { Server } from 'node:http'

import { GCP_PROJECT, SENTRY_DSN } from './config'
import typeDefs from './schema'
import { rootResolver as resolvers } from './resolvers/rootResolver'
import sentryPlugin from './plugins/sentry'
import loggingPlugin from './plugins/logging'
import { userFromAuthorizationHeader } from './services/authentication'
import { allowUser } from './services/permissions'
import { UnexpectedError, ValidationError } from './errors'
import { logger } from './services/logger'
import { createDataSources, dataSourceCache } from './store/firestoreDataSource'

import type { DataSources } from './store/firestoreDataSource'
import type { UserDoc } from './store/schema'

export async function initApollo (httpServer: Server) {
  const plugins = [
    loggingPlugin,
    ApolloServerPluginDrainHttpServer({ httpServer }),
    ApolloServerPluginCacheControl({ })
  ]

  if (SENTRY_DSN != null) {
    plugins.push(sentryPlugin)
  }

  const schema = makeExecutableSchema({ typeDefs, resolvers })

  const server = new ApolloServer({
    schema,
    plugins,
    cache: dataSourceCache,
    logger: logger.child({ name: 'apollo-server' }),
    introspection: true,
    formatError (formattedError, wrappedOriginal) {
      const error = unwrapResolverError(wrappedOriginal)
      let err: GraphQLError
      if (error instanceof GraphQLError) err = error
      else if (error instanceof z.ZodError) {
        const formatted = fromZodError(error)
        err = new ValidationError(formatted.message, { extensions: { issues: error.issues } })
      } else err = new UnexpectedError(error as Error)

      logger.error(err)
      return err
    }
  })

  await server.start()

  return expressMiddleware(server, {
    async context (context: ExpressContextFunctionArgument): Promise<ApolloContext> {
      const dataSources = createDataSources()

      const trace = context.req.get('X-Cloud-Trace-Context')
      const childLogger = logger.child({
        ...(GCP_PROJECT && trace ? { 'logging.googleapis.com/trace': `project/${GCP_PROJECT}/traces/${trace}` } : {})
      })
      const authHeader = context.req.get('authorization')
      const user = await userFromAuthorizationHeader(authHeader, { logger: childLogger, dataSources })

      return {
        ...context,
        dataSources,
        user,
        allowUser: allowUser(user, { logger: childLogger }),
        logger: childLogger
      }
    }
  })
}

export interface TrickContext {
  dataSources: DataSources
  user?: UserDoc
  allowUser: ReturnType<typeof allowUser>
  logger: Pino.Logger
}

export type ApolloContext = ExpressContextFunctionArgument & BaseContext & TrickContext
