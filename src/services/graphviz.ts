import { instance } from '@viz-js/viz'

import type { RenderOptions, Viz } from '@viz-js/viz'

// Graphviz compiled to WebAssembly, one instance for the process
let viz: Promise<Viz> | undefined

/** Lays a DOT graph out and draws it as SVG */
export async function renderDotToSvg (dot: string, options: Omit<RenderOptions, 'format'> = {}): Promise<string> {
  viz ??= instance()
  return (await viz).renderString(dot, { ...options, format: 'svg' })
}
