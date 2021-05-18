import { ApolloServer } from 'apollo-server'
import type { DataSources as ApolloDataSources } from 'apollo-server-core/dist/graphqlOptions'
import * as Sentry from '@sentry/node'
import '@sentry/tracing'

import { SENTRY_DSN } from './config'
import typeDefs from './schema'
import { rootResolver as resolvers } from './resolvers/rootResolver'
import sentryPlugin from './plugins/sentry'
import { userFromAuthorizationHeader } from './services/authentication'
import { allowUser } from './services/permissions'
import {
  trickDataSource,
  trickLocalisationDataSource,
  userDataSource
} from './store/firestoreDataSource'

import type {
  TrickDataSource,
  TrickLocalisationDataSource,
  UserDataSource
} from './store/firestoreDataSource'
import type { UserDoc } from './store/schema'

const plugins = []

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
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
    users: userDataSource as any,
    tricks: trickDataSource as any,
    trickLocalisations: trickLocalisationDataSource as any
  }),
  plugins,
  // cors: ['the-tricktionary.com', 'localhost'],
  context: async (context) => {
    const authHeader = context.req.get('authorization')
    const user = await userFromAuthorizationHeader(authHeader)

    return {
      ...context,
      user,
      allowUser: allowUser(user)
    }
  }
})

interface DataSources {
  users: UserDataSource
  tricks: TrickDataSource
  trickLocalisations: TrickLocalisationDataSource
}

export type DataSourceContext = ApolloDataSources<DataSources>

export interface ApolloContext {
  dataSources: DataSources
  user?: UserDoc
  allowUser: ReturnType<typeof allowUser>
}
