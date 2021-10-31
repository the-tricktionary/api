import { ApolloServer } from 'apollo-server'
import * as Sentry from '@sentry/node'
import responseCachePlugin from 'apollo-server-plugin-response-cache'

import type { DataSources as ApolloDataSources } from 'apollo-server-core/dist/graphqlOptions'
import type { BaseContext } from 'apollo-server-plugin-base'
import type Pino from 'pino'

import { GCP_PROJECT, GITHUB_SHA, SENTRY_DSN } from './config'
import typeDefs from './schema'
import { rootResolver as resolvers } from './resolvers/rootResolver'
import sentryPlugin from './plugins/sentry'
import loggingPlugin from './plugins/logging'
import { userFromAuthorizationHeader } from './services/authentication'
import { allowUser } from './services/permissions'
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

const plugins = [loggingPlugin, responseCachePlugin()]

if (SENTRY_DSN) {
  logger.info('Sentry enabled')
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `tricktionary-api@${GITHUB_SHA}`,
    integrations: [
      new Sentry.Integrations.Http({ tracing: true })
    ],
    tracesSampleRate: 1.0
  })
  plugins.push(sentryPlugin)
}

export const server = new ApolloServer({
  typeDefs,
  resolvers,
  dataSources: (): DataSourceContext => ({
    eventDefinitions: eventDefinitionDataSource as any,
    speedResults: speedResultDataSource as any,
    tricks: trickDataSource as any,
    trickLocalisations: trickLocalisationDataSource as any,
    trickPrerequisites: trickPrerequisiteDataSource as any,
    trickLevels: trickLevelDataSource as any,
    trickCompletions: trickCompletionDataSource as any,
    users: userDataSource as any
  }),
  plugins,
  cors: {
    origin: [
      'https://the-tricktionary.com',
      /\.the-tricktionary\.com$/,
      /^https:\/\/tricktionary-v4--.+\.web\.app$/,
      /^https?:\/\/localhost(:\d+)?$/,
      'https://studio.apollographql.com'
    ]
  },
  logger: logger.child({ name: 'apollo-server' }),
  context: async (context) => {
    const trace = context.req.get('X-Cloud-Trace-Context')
    const childLogger = logger.child({
      ...(GCP_PROJECT && trace ? { 'logging.googleapis.com/trace': `project/${GCP_PROJECT ?? ''}/traces/${trace ?? ''}` } : {})
    })
    const authHeader = context.req.get('authorization')
    const user = await userFromAuthorizationHeader(authHeader, { logger: childLogger })

    return {
      ...context,
      user,
      allowUser: allowUser(user, { logger: childLogger }),
      logger: childLogger
    }
  }
})

interface DataSources {
  eventDefinitions: EventDefinitionDataSource
  speedResults: SpeedResultDataSource
  tricks: TrickDataSource
  trickLocalisations: TrickLocalisationDataSource
  trickPrerequisites: TrickPrerequisiteDataSource
  trickLevels: TrickLevelDataSource
  trickCompletions: TrickCompletionDataSource
  users: UserDataSource
}

export type DataSourceContext = ApolloDataSources<DataSources>

export type ApolloContext = BaseContext & TrickContext

export interface TrickContext {
  dataSources: DataSources
  user?: UserDoc
  allowUser: ReturnType<typeof allowUser>
  logger: Pino.Logger
}
