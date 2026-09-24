import { createHash, randomBytes } from 'node:crypto'
import { Scope } from '../generated/graphql.js'
import { adminOrigins, apiOrigins, originPattern, webOrigins } from '../helpers/cors.js'
import { apiClientDocSchema } from '../validation.js'
import { apiClientDataSource, apiKeyDataSource, dataSourceCache } from '../store/firestoreDataSource.js'
import { logger } from './logger.js'

import type { Timestamp } from '@google-cloud/firestore'
import type { ApiClientDoc } from '../store/schema.js'

/** Who a request comes from, see the README */
export interface ApiClient {
  id: string
  name: string
  scopes: ReadonlySet<Scope>
  /** Browser origins, none for a client that only calls from servers */
  origins: readonly RegExp[]
}

export const ANONYMOUS: ApiClient = {
  id: 'anonymous',
  name: 'Anonymous',
  scopes: new Set([Scope.Public]),
  origins: apiOrigins
}

/** In code rather than in `api-clients`, so their scopes change with the schema */
export const OWN_CLIENTS: readonly ApiClient[] = [
  {
    id: 'web',
    name: 'the Tricktionary',
    scopes: new Set([Scope.Public, Scope.Site, Scope.Profiles, Scope.Account]),
    origins: webOrigins
  },
  {
    id: 'admin',
    name: 'the Tricktionary admin',
    scopes: new Set([Scope.Public, Scope.Site, Scope.Account, Scope.Admin]),
    origins: adminOrigins
  }
]

export const BUILT_IN_CLIENTS: readonly ApiClient[] = [ANONYMOUS, ...OWN_CLIENTS]

/** How long a change in `api-clients` or `api-keys` takes to count */
const REGISTRY_TTL = 60_000

const KEY_HINT_LENGTH = 8

/** What the `ApiClient` type resolves from */
export interface ApiClientModel {
  id: string
  name: string
  contact?: string
  scopes: Scope[]
  origins: string[]
  builtIn: boolean
  enabled: boolean
  createdAt?: Timestamp
  updatedAt?: Timestamp
}

export function builtInClientModel ({ id, name, scopes, origins }: ApiClient): ApiClientModel {
  return { id, name, scopes: [...scopes], origins: origins.map(pattern => pattern.source), builtIn: true, enabled: true }
}

export function registeredClientModel ({ id, name, contact, scopes, origins, enabled, createdAt, updatedAt }: ApiClientDoc): ApiClientModel {
  return { id, name, ...(contact != null ? { contact } : {}), scopes, origins, builtIn: false, enabled, createdAt, updatedAt }
}

export interface ApiClientRegistry {
  /** By the hash of the key */
  byKey: ReadonlyMap<string, ApiClient>
  /** Every client's origins, which a CORS preflight is answered for */
  origins: readonly RegExp[]
}

function hashApiKey (key: string) {
  return createHash('sha256').update(key).digest('hex')
}

/** The key, and the document ID and hint it's stored by */
export function generateApiKey () {
  const key = `pk_${randomBytes(24).toString('base64url')}`
  return { key, id: hashApiKey(key), hint: key.slice(0, KEY_HINT_LENGTH) }
}

function registeredClient (id: string, data: unknown): ApiClient | null {
  const parsed = apiClientDocSchema.safeParse(data)
  if (!parsed.success) {
    logger.error({ clientId: id, issues: parsed.error.issues }, 'Ignoring an API client that does not parse')
    return null
  }
  const { name, scopes, origins, enabled } = parsed.data
  if (!enabled) return null
  return { id, name, scopes: new Set(scopes), origins: origins.map(originPattern) }
}

async function loadRegistry (): Promise<ApiClientRegistry> {
  const [registered, keys] = await Promise.all([
    apiClientDataSource(dataSourceCache).findAll(),
    apiKeyDataSource(dataSourceCache).findAll()
  ])

  const clients = new Map<string, ApiClient>(OWN_CLIENTS.map(client => [client.id, client]))
  for (const doc of registered) {
    if (clients.has(doc.id) || doc.id === ANONYMOUS.id) {
      logger.error({ clientId: doc.id }, 'Ignoring an API client document with the ID of a built in client')
      continue
    }
    const client = registeredClient(doc.id, doc)
    if (client != null) clients.set(doc.id, client)
  }

  const byKey = new Map<string, ApiClient>()
  for (const key of keys) {
    const client = clients.get(key.clientId)
    if (key.revokedAt == null && client != null) byKey.set(key.id, client)
  }

  return {
    byKey,
    origins: [ANONYMOUS, ...clients.values()].flatMap(client => client.origins)
  }
}

let registry: { value: ApiClientRegistry, loadedAt: number } | undefined
let loading: Promise<ApiClientRegistry> | undefined

/** A failed reload keeps the clients loaded before */
export async function apiClientRegistry (): Promise<ApiClientRegistry> {
  if (registry != null && Date.now() - registry.loadedAt < REGISTRY_TTL) return registry.value

  loading ??= loadRegistry()
    .then(value => {
      registry = { value, loadedAt: Date.now() }
      return value
    })
    .catch(err => {
      if (registry == null) throw err
      logger.error(err, 'Could not reload the API clients, keeping the ones loaded before')
      registry = { value: registry.value, loadedAt: Date.now() }
      return registry.value
    })
    .finally(() => { loading = undefined })

  return await loading
}

/** Anonymous without a key, null for a key nobody holds */
export async function apiClientByKey (key: string | undefined): Promise<ApiClient | null> {
  if (key == null || key === '') return ANONYMOUS
  return (await apiClientRegistry()).byKey.get(hashApiKey(key)) ?? null
}

export function allowsOrigin (client: ApiClient, origin: string) {
  return client.origins.some(pattern => pattern.test(origin))
}
