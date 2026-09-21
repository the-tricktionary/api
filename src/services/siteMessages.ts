import { logger as baseLogger } from './logger.js'

import type Pino from 'pino'

/**
 * The public site's English interface messages, from its `en.json`, flattened
 * to dotted keys like `enums.trickType.Basic`. English is the site's source
 * language and lives in its repository, the API only holds translations, so
 * this is where the booklets get their English labels. Cached for an hour,
 * and served stale rather than failing when the site can't be reached.
 */

const TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

export type FlatMessages = Record<string, string>

let cached: { messages: FlatMessages, fetchedAt: number } | undefined
let inflight: Promise<FlatMessages> | undefined

export function flattenMessages (messages: unknown, prefix = ''): FlatMessages {
  const flat: FlatMessages = {}
  if (typeof messages !== 'object' || messages === null) return flat
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') flat[path] = value
    else if (typeof value === 'object' && value !== null) Object.assign(flat, flattenMessages(value, path))
  }
  return flat
}

interface SiteMessagesOptions {
  /** The public site, `WEB_URL` in the configuration */
  webUrl: string
  logger?: Pino.Logger
}

export async function siteEnglishMessages ({ webUrl, logger = baseLogger }: SiteMessagesOptions): Promise<FlatMessages> {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.messages
  inflight ??= fetchMessages(webUrl, logger).finally(() => { inflight = undefined })
  return await inflight
}

async function fetchMessages (webUrl: string, logger: Pino.Logger): Promise<FlatMessages> {
  const url = new URL('/locales/en.json', webUrl)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) throw new Error(`${url.href} answered ${response.status}`)
    const messages = flattenMessages(await response.json())
    cached = { messages, fetchedAt: Date.now() }
    return messages
  } catch (err) {
    logger.warn(err, 'Could not fetch the site\'s English messages, using what we have')
    return cached?.messages ?? {}
  }
}
