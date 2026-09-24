/**
 * API clients and their keys, see the README.
 *
 *   client <id> --name <name> [--scope <scope>]... [--origin <regex>]... [--contact <text>]
 *       creates or replaces a registered client, `web`, `admin` and
 *       `anonymous` are built in and can't be registered
 *   disable <id> / enable <id>
 *       a disabled client's keys stop working, they're kept
 *   issue <client id>
 *       prints a new key for the client, which is shown this once
 *   revoke <key or hint>
 *       a hint is the start of a key as `list` shows it
 *   list
 *
 * Keys take up to a minute to start or stop working, the API reloads them
 * every minute.
 *
 * Requirements:
 *   - GOOGLE_APPLICATION_CREDENTIALS pointing at a service account with write
 *     access to the `api-clients` and `api-keys` collections
 *
 * Usage:
 *   npx tsx src/scripts/api-keys.ts <command> [arguments]
 */
import '../config.js'
import { parseArgs } from 'node:util'
import { Firestore, Timestamp } from '@google-cloud/firestore'
import { generateApiKey, hashApiKey, REGISTERED_CLIENT_SCOPES } from '../services/apiClients.js'
import { apiClientDocSchema } from '../validation.js'

import type { ApiClientDoc, ApiKeyDoc } from '../store/schema.js'

type Fields<T> = Omit<T, 'id' | 'collection'>

const BUILT_IN = ['anonymous', 'web', 'admin']
const HINT_LENGTH = 8

const firestore = new Firestore()
const clients = firestore.collection('api-clients')
const keys = firestore.collection('api-keys')

function out (line = '') {
  process.stdout.write(`${line}\n`)
}

async function registerClient (id: string, args: string[]) {
  if (BUILT_IN.includes(id)) throw new Error(`${id} is built in, its scopes and origins are in src/services/apiClients.ts`)
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      scope: { type: 'string', multiple: true, default: [] },
      origin: { type: 'string', multiple: true, default: [] },
      contact: { type: 'string' }
    }
  })
  const parsed = apiClientDocSchema.parse({ name: values.name, scopes: values.scope, origins: values.origin, contact: values.contact })
  const refused = parsed.scopes.filter(scope => !REGISTERED_CLIENT_SCOPES.has(scope))
  if (refused.length > 0) throw new Error(`Only the Tricktionary's own apps may hold ${refused.join(' and ')}`)
  for (const origin of parsed.origins) new RegExp(origin) // eslint-disable-line no-new

  const ref = clients.doc(id)
  const now = Timestamp.now()
  const existing = await ref.get()
  const doc: Fields<ApiClientDoc> = {
    name: parsed.name,
    scopes: parsed.scopes,
    origins: parsed.origins,
    ...(parsed.contact != null ? { contact: parsed.contact } : {}),
    createdAt: existing.exists ? existing.get('createdAt') ?? now : now,
    updatedAt: now
  }
  await ref.set(doc)
  out(`${existing.exists ? 'Replaced' : 'Registered'} ${id}: ${doc.scopes.join(' ') || 'no scopes'}`)
}

async function setDisabled (id: string, disabled: boolean) {
  const ref = clients.doc(id)
  if (!(await ref.get()).exists) throw new Error(`There is no registered client ${id}`)
  await ref.update({ disabled, updatedAt: Timestamp.now() })
  out(`${disabled ? 'Disabled' : 'Enabled'} ${id}`)
}

async function issue (clientId: string) {
  if (!BUILT_IN.includes(clientId) && !(await clients.doc(clientId).get()).exists) throw new Error(`There is no client ${clientId}`)
  if (clientId === 'anonymous') throw new Error('Anonymous means no key')

  const key = generateApiKey()
  const now = Timestamp.now()
  const doc: Fields<ApiKeyDoc> = { clientId, hint: key.slice(0, HINT_LENGTH), createdAt: now, updatedAt: now }
  await keys.doc(hashApiKey(key)).create(doc)
  out(`A key for ${clientId}, it won't be shown again:`)
  out()
  out(key)
}

async function revoke (keyOrHint: string) {
  const matches = keyOrHint.length > HINT_LENGTH
    ? [await keys.doc(hashApiKey(keyOrHint)).get()].filter(dSnap => dSnap.exists)
    : (await keys.where('hint', '==', keyOrHint).get()).docs
  if (matches.length !== 1) throw new Error(`${matches.length} keys match ${keyOrHint}, give the whole key`)
  const [dSnap] = matches
  await dSnap.ref.update({ revokedAt: Timestamp.now(), updatedAt: Timestamp.now() })
  out(`Revoked ${String(dSnap.get('hint'))}… of ${String(dSnap.get('clientId'))}`)
}

async function list () {
  const [clientsSnap, keysSnap] = await Promise.all([clients.get(), keys.get()])
  const keysByClient = Map.groupBy(keysSnap.docs.map(dSnap => dSnap.data() as Fields<ApiKeyDoc>), key => key.clientId)
  const describeKeys = (id: string) => (keysByClient.get(id) ?? [])
    .map(key => `    ${key.hint}…  issued ${key.createdAt.toDate().toISOString().slice(0, 10)}${key.revokedAt != null ? `, revoked ${key.revokedAt.toDate().toISOString().slice(0, 10)}` : ''}`)

  for (const id of ['web', 'admin']) {
    out(`${id} (built in)`)
    describeKeys(id).forEach(line => { out(line) })
  }
  for (const dSnap of clientsSnap.docs) {
    const client = dSnap.data() as Fields<ApiClientDoc>
    out(`${dSnap.id}: ${client.name}${client.disabled === true ? ', disabled' : ''}, ${client.scopes.join(' ') || 'no scopes'}${client.origins.length > 0 ? `, from ${client.origins.join(' ')}` : ''}`)
    describeKeys(dSnap.id).forEach(line => { out(line) })
  }
}

const [command, id, ...rest] = process.argv.slice(2)
const commands: Record<string, () => Promise<void>> = {
  client: async () => { await registerClient(id, rest) },
  disable: async () => { await setDisabled(id, true) },
  enable: async () => { await setDisabled(id, false) },
  issue: async () => { await issue(id) },
  revoke: async () => { await revoke(id) },
  list
}

const run = commands[command]
if (run == null || (command !== 'list' && id == null)) {
  process.stderr.write('Usage: npx tsx src/scripts/api-keys.ts client|disable|enable|issue|revoke|list [arguments], see the top of the file\n')
  process.exit(1)
}
await run()
