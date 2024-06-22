import { ApolloServer, type BaseContext } from '@apollo/server'
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer'
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import { expressMiddleware, type ExpressContextFunctionArgument } from '@apollo/server/express4'
import { InMemoryLRUCache } from '@apollo/utils.keyvaluecache'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { fromZodError } from 'zod-validation-error'
import { unwrapResolverError } from '@apollo/server/errors'
import z from 'zod'
import { GraphQLError } from 'graphql'
import type Pino from 'pino'
import type { Server } from 'http'

import { GCP_PROJECT, SENTRY_DSN } from './config'
import typeDefs from './schema'
import { rootResolver as resolvers } from './resolvers/rootResolver'
import sentryPlugin from './plugins/sentry'
import loggingPlugin from './plugins/logging'
import { userFromAuthorizationHeader } from './services/authentication'
import { allowUser } from './services/permissions'
import { UnexpectedError, ValidationError } from './errors'
import { logger } from './services/logger'
import {
  eventDefinitionDataSource,
  speedResultDataSource,
  trickPrerequisiteDataSource,
  trickDataSource,
  trickCompletionDataSource,
  trickLevelDataSource,
  trickLocalisationDataSource,
  userDataSource
} from './store/firestoreDataSource'

import type {
  EventDefinitionDataSource,
  SpeedResultDataSource,
  TrickPrerequisiteDataSource,
  TrickDataSource,
  TrickCompletionDataSource,
  TrickLevelDataSource,
  TrickLocalisationDataSource,
  UserDataSource
} from './store/firestoreDataSource'
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

  const cache = new InMemoryLRUCache()

  const server = new ApolloServer({
    schema,
    plugins,
    cache,
    logger: logger.child({ name: 'apollo-server' }),
    introspection: true,
    // https://www.apollographql.com/docs/apollo-server/migration/#appropriate-400-status-codes
    status400ForVariableCoercionErrors: true,
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
    async context (context) {
      const dataSources = {
        eventDefinitions: eventDefinitionDataSource(cache),
        speedResults: speedResultDataSource(cache),
        tricks: trickDataSource(cache),
        trickLocalisations: trickLocalisationDataSource(cache),
        trickPrerequisites: trickPrerequisiteDataSource(cache),
        trickLevels: trickLevelDataSource(cache),
        trickCompletions: trickCompletionDataSource(cache),
        users: userDataSource(cache)
      }

     const trace = context.req.get('X-Cloud-Trace-Context')
    const childLogger = logger.child({
      ...(GCP_PROJECT && trace ? { 'logging.googleapis.com/trace': `project/${GCP_PROJECT ?? ''}/traces/${trace ?? ''}` } : {})
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

export interface DataSources {
  eventDefinitions: EventDefinitionDataSource
  speedResults: SpeedResultDataSource
  tricks: TrickDataSource
  trickLocalisations: TrickLocalisationDataSource
  trickPrerequisites: TrickPrerequisiteDataSource
  trickLevels: TrickLevelDataSource
  trickCompletions: TrickCompletionDataSource
  users: UserDataSource
}

export interface TrickContext {
  dataSources: DataSources
  user?: UserDoc
  allowUser: ReturnType<typeof allowUser>
  logger: Pino.Logger
}

export type ApolloContext = ExpressContextFunctionArgument & BaseContext & TrickContext
