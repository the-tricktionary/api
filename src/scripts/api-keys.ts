/**
 * API clients and their keys, see the README.
 *
 *   client <id> --name <name> [--scope <scope>]... [--origin <regex>]... [--contact <text>]
 *       creates or replaces a registered client
 *   disable <id> / enable <id>
 *       a disabled client's keys stop working until it's enabled
 *   issue <client id>
 *       prints a new key, which is shown this once
 *   revoke <key or hint>
 *       a hint is the start of a key, as `list` shows it
 *   list
 *
 * Changes take up to a minute to reach the API.
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
import { ANONYMOUS, generateApiKey, hashApiKey, OWN_CLIENTS } from '../services/apiClients.js'
import { apiClientDocSchema } from '../validation.js'

import type { ApiClientDoc, ApiKeyDoc } from '../store/schema.js'

type Fields<T> = Omit<T, 'id' | 'collection'>

const OWN_CLIENT_IDS = OWN_CLIENTS.map(client => client.id)
const HINT_LENGTH = 8

const firestore = new Firestore()
const clients = firestore.collection('api-clients')
const keys = firestore.collection('api-keys')

function out (line = '') {
  process.stdout.write(`${line}\n`)
}

function date (timestamp: Timestamp) {
  return timestamp.toDate().toISOString().slice(0, 10)
}

async function registerClient (id: string, args: string[]) {
  if (id === ANONYMOUS.id || OWN_CLIENT_IDS.includes(id)) throw new Error(`${id} is built in, see src/services/apiClients.ts`)
  const { values } = parseArgs({
    args,
    options: {
      name: { type: 'string' },
      scope: { type: 'string', multiple: true, default: [] },
      origin: { type: 'string', multiple: true, default: [] },
      contact: { type: 'string' }
    }
  })
  const { name, scopes, origins, contact } = apiClientDocSchema.parse({ name: values.name, scopes: values.scope, origins: values.origin, contact: values.contact })

  const ref = clients.doc(id)
  const now = Timestamp.now()
  const existing = await ref.get()
  const doc: Fields<ApiClientDoc> = {
    name,
    scopes,
    origins,
    ...(contact != null ? { contact } : {}),
    createdAt: existing.exists ? existing.get('createdAt') ?? now : now,
    updatedAt: now
  }
  await ref.set(doc)
  out(`${existing.exists ? 'Replaced' : 'Registered'} ${id}: ${scopes.join(' ') || 'no scopes'}`)
}

async function setDisabled (id: string, disabled: boolean) {
  const ref = clients.doc(id)
  if (!(await ref.get()).exists) throw new Error(`There is no registered client ${id}`)
  await ref.update({ disabled, updatedAt: Timestamp.now() })
  out(`${disabled ? 'Disabled' : 'Enabled'} ${id}`)
}

async function issue (clientId: string) {
  if (clientId === ANONYMOUS.id) throw new Error('Anonymous means no key')
  if (!OWN_CLIENT_IDS.includes(clientId) && !(await clients.doc(clientId).get()).exists) throw new Error(`There is no client ${clientId}`)

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
  const listKeys = (id: string) => {
    for (const key of keysByClient.get(id) ?? []) {
      out(`    ${key.hint}…  issued ${date(key.createdAt)}${key.revokedAt != null ? `, revoked ${date(key.revokedAt)}` : ''}`)
    }
  }

  for (const id of OWN_CLIENT_IDS) {
    out(`${id} (built in)`)
    listKeys(id)
  }
  for (const dSnap of clientsSnap.docs) {
    const client = dSnap.data() as Fields<ApiClientDoc>
    out(`${dSnap.id}: ${client.name}${client.disabled === true ? ', disabled' : ''}, ${client.scopes.join(' ') || 'no scopes'}${client.origins.length > 0 ? `, from ${client.origins.join(' ')}` : ''}`)
    listKeys(dSnap.id)
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
