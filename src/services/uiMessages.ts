import type { UiMessageLeaf, UiMessagesDoc } from '../store/schema.js'

/** A message with its dotted key, as the admin lists them */
export interface UiMessageEntry {
  key: string
  leaf: UiMessageLeaf
}

export function uiMessageEntries (messages: UiMessagesDoc['messages'] | undefined): UiMessageEntry[] {
  return Object.entries(messages ?? {})
    .map(([key, leaf]) => ({ key, leaf }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

/** Only the strings, keyed like the site's en.json, what vue-i18n's flatJson consumes */
export function uiMessageValues (messages: UiMessagesDoc['messages'] | undefined) {
  return Object.fromEntries(Object.entries(messages ?? {}).map(([key, leaf]) => [key, leaf.value]))
}
