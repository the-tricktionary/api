import type { UiMessageLeaf, UiMessageTree } from '../store/schema.js'

/** A message with its dotted key, as the admin lists them */
export interface UiMessageEntry {
  key: string
  leaf: UiMessageLeaf
}

/** The message tree with only the strings left, the shape vue-i18n consumes */
export interface UiMessageValues { [key: string]: UiMessageValues | string }

export function isUiMessageLeaf (node: unknown): node is UiMessageLeaf {
  if (typeof node !== 'object' || node == null) return false
  const leaf = node as UiMessageLeaf
  return typeof leaf.value === 'string' && typeof leaf.updatedBy === 'string'
}

export function flattenUiMessages (tree: UiMessageTree): UiMessageEntry[] {
  const entries: UiMessageEntry[] = []

  function walk (node: UiMessageTree, prefix: string) {
    for (const [key, child] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (isUiMessageLeaf(child)) entries.push({ key: path, leaf: child })
      else walk(child, path)
    }
  }
  walk(tree, '')

  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

export function uiMessageValues (tree: UiMessageTree): UiMessageValues {
  const values: UiMessageValues = {}
  for (const [key, node] of Object.entries(tree)) {
    values[key] = isUiMessageLeaf(node) ? node.value : uiMessageValues(node)
  }
  return values
}

/**
 * Turns `a.b.c` into `{ a: { b: { c: value } } }`, nesting into `target` when
 * one is given so several keys can share a single object.
 */
export function nestUiMessage (key: string, value: unknown, target: Record<string, any> = {}) {
  const parts = key.split('.')
  const leafKey = parts.pop()!
  let branch = target
  for (const part of parts) branch = branch[part] ??= {}
  branch[leafKey] = value
  return target
}
