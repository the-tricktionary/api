import { createHash, randomBytes } from 'node:crypto'
import { Scope } from '../generated/graphql.js'
import { adminOrigins, webOrigins } from '../helpers/cors.js'
import { apiClientDocSchema } from '../validation.js'
import { firestore } from '../store/firestoreDataSource.js'
import { logger } from './logger.js'

import type { ApiKeyDoc } from '../store/schema.js'

/**
 * Who a request comes from: one of the Tricktionary's own apps, a client
 * registered in the `api-clients` collection, or nobody in particular. See the
 * README.
 */
export interface ApiClient {
  id: string
  name: string
  scopes: ReadonlySet<Scope>
  /** The browser origins the client may call from, none for one that only calls from servers */
  origins: readonly RegExp[]
}

/** A request without a key */
export const ANONYMOUS: ApiClient = {
  id: 'anonymous',
  name: 'Anonymous',
  scopes: new Set([Scope.Public]),
  origins: []
}

/**
 * The Tricktionary's own apps are defined here rather than in the
 * collection: their scopes change along with the schema they use
 */
const OWN_CLIENTS: readonly ApiClient[] = [
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

/**
 * All a client from the collection may hold. Users only sign in to the
 * Tricktionary's own apps, and the admin interface is one of them.
 */
export const REGISTERED_CLIENT_SCOPES: ReadonlySet<Scope> = new Set([Scope.Public, Scope.Site, Scope.Profiles])

/** How long a key added or revoked in Firestore takes to count */
const REGISTRY_TTL = 60_000

export interface ApiClientRegistry {
  /** By the hash of the key */
  byKey: ReadonlyMap<string, ApiClient>
  /** Every origin any client may call from, what a CORS preflight is answered with */
  origins: readonly RegExp[]
}

/** Keys are stored by this, never as they are */
export function hashApiKey (key: string) {
  return createHash('sha256').update(key).digest('hex')
}

/** `pk_` and 32 URL-safe characters */
export function generateApiKey () {
  return `pk_${randomBytes(24).toString('base64url')}`
}

/** A regular expression the whole origin has to match, null for one that doesn't compile */
function originPattern (source: string) {
  try {
    return new RegExp(`^(?:${source})$`)
  } catch {
    return null
  }
}

function registeredClient (id: string, data: unknown): ApiClient | null {
  const parsed = apiClientDocSchema.safeParse(data)
  if (!parsed.success) {
    logger.error({ clientId: id, issues: parsed.error.issues }, 'Ignoring an API client that does not parse')
    return null
  }
  const doc = parsed.data
  if (doc.disabled === true) return null

  const refused = doc.scopes.filter(scope => !REGISTERED_CLIENT_SCOPES.has(scope))
  if (refused.length > 0) logger.error({ clientId: id, refused }, 'Leaving out scopes only the Tricktionary\'s own apps may hold')

  const origins = doc.origins.flatMap(source => {
    const pattern = originPattern(source)
    if (pattern == null) logger.error({ clientId: id, origin: source }, 'Leaving out an origin that is not a regular expression')
    return pattern == null ? [] : [pattern]
  })

  return {
    id,
    name: doc.name,
    scopes: new Set(doc.scopes.filter(scope => REGISTERED_CLIENT_SCOPES.has(scope))),
    origins
  }
}

async function loadRegistry (): Promise<ApiClientRegistry> {
  const [clientsSnap, keysSnap] = await Promise.all([
    firestore.collection('api-clients').get(),
    firestore.collection('api-keys').get()
  ])

  const clients = new Map<string, ApiClient>(OWN_CLIENTS.map(client => [client.id, client]))
  for (const dSnap of clientsSnap.docs) {
    if (clients.has(dSnap.id) || dSnap.id === ANONYMOUS.id) {
      logger.error({ clientId: dSnap.id }, 'Ignoring an API client document that has the ID of a built in client')
      continue
    }
    const client = registeredClient(dSnap.id, dSnap.data())
    if (client != null) clients.set(dSnap.id, client)
  }

  const byKey = new Map<string, ApiClient>()
  for (const dSnap of keysSnap.docs) {
    const key = dSnap.data() as ApiKeyDoc
    if (key.revokedAt != null) continue
    const client = clients.get(key.clientId)
    // a key of a disabled client lands here too
    if (client == null) continue
    byKey.set(dSnap.id, client)
  }

  return {
    byKey,
    origins: [...clients.values()].flatMap(client => client.origins)
  }
}

let registry: { value: ApiClientRegistry, loadedAt: number } | undefined
let loading: Promise<ApiClientRegistry> | undefined

/**
 * The clients and their keys, reloaded when a minute old. A failed reload
 * keeps what was loaded before, and tries again a minute later.
 */
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

/** The client a key belongs to, anonymous without one, null for a key nobody holds */
export async function apiClientByKey (key: string | undefined): Promise<ApiClient | null> {
  if (key == null || key === '') return ANONYMOUS
  return (await apiClientRegistry()).byKey.get(hashApiKey(key)) ?? null
}

export function allowsOrigin (client: ApiClient, origin: string) {
  return client.origins.some(pattern => pattern.test(origin))
}
