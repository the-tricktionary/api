import { Timestamp } from '@google-cloud/firestore'

import { NotFoundError, ValidationError } from '../errors.js'
import { ANONYMOUS, BUILT_IN_CLIENTS, builtInClientModel, generateApiKey, registeredClientModel } from '../services/apiClients.js'
import { apiClientIdSchema, apiClientInputSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { ApiClientDoc, ApiKeyDoc } from '../store/schema.js'

function builtIn (clientId: string) {
  return BUILT_IN_CLIENTS.find(client => client.id === clientId)
}

/** Without `contact` when there is none, Firestore takes no undefined */
function clientFields (data: unknown) {
  const { contact, ...fields } = apiClientInputSchema.parse(data)
  return { ...fields, ...(contact != null ? { contact } : {}) }
}

async function registeredClient (clientId: string, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  if (builtIn(clientId) != null) throw new ValidationError(`${clientId} is built in, only its keys can change`)
  const client = await dataSources.apiClients.findOneById(clientId)
  if (!client) throw new NotFoundError(`API client ${clientId} not found`, { extensions: { entity: 'api-client', id: clientId } })
  return client
}

export const apiClientResolvers: Resolvers = {
  Query: {
    async apiClients (_, args, { dataSources, allowUser }) {
      allowUser.manageApiClients.assert()
      const registered = await dataSources.apiClients.findAll()
      return [
        ...BUILT_IN_CLIENTS.map(builtInClientModel),
        ...registered.sort((a, b) => a.name.localeCompare(b.name)).map(registeredClientModel)
      ]
    }
  },
  Mutation: {
    async createApiClient (_, { clientId, data }, { dataSources, allowUser }) {
      allowUser.manageApiClients.assert()
      const id = apiClientIdSchema.parse(clientId)
      if (builtIn(id) != null || await dataSources.apiClients.findOneById(id)) {
        throw new ValidationError(`There already is an API client ${id}`)
      }
      const client = await (dataSources.apiClients.createOne({ id, ...clientFields(data), enabled: true }) as Promise<ApiClientDoc>)
      return registeredClientModel(client)
    },
    async updateApiClient (_, { clientId, data }, context) {
      context.allowUser.manageApiClients.assert()
      const existing = await registeredClient(clientId, context)
      // a whole set, so a contact left out is removed
      const client = await (context.dataSources.apiClients.updateOne({ id: existing.id, ...clientFields(data), enabled: existing.enabled }) as Promise<ApiClientDoc>)
      return registeredClientModel(client)
    },
    async setApiClientEnabled (_, { clientId, enabled }, context) {
      context.allowUser.manageApiClients.assert()
      const existing = await registeredClient(clientId, context)
      const client = await (context.dataSources.apiClients.updateOnePartial(existing.id, { enabled }) as Promise<ApiClientDoc>)
      return registeredClientModel(client)
    },
    async issueApiKey (_, { clientId }, context) {
      context.allowUser.manageApiClients.assert()
      if (clientId === ANONYMOUS.id) throw new ValidationError('Anonymous means without a key')
      if (builtIn(clientId) == null) await registeredClient(clientId, context)

      const { key, id, hint } = generateApiKey()
      const apiKey = await (context.dataSources.apiKeys.createOne({ id, clientId, hint }) as Promise<ApiKeyDoc>)
      return { key, apiKey }
    },
    async revokeApiKey (_, { keyId }, { dataSources, allowUser }) {
      allowUser.manageApiClients.assert()
      const existing = await dataSources.apiKeys.findOneById(keyId)
      if (!existing) throw new NotFoundError(`API key ${keyId} not found`, { extensions: { entity: 'api-key', id: keyId } })
      if (existing.revokedAt != null) return existing
      return await (dataSources.apiKeys.updateOnePartial(existing.id, { revokedAt: Timestamp.now() }) as Promise<ApiKeyDoc>)
    }
  },
  ApiClient: {
    async keys (client, _, { dataSources }) {
      const keys = await dataSources.apiKeys.findManyByClient(client.id)
      return keys.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    }
  }
}
