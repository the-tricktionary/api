/**
 * Typesets the booklet template against fixture data in every layout, so that
 * a change to the template, the Typst version or the data it is given fails
 * here rather than in production. The QA workflow runs it, and so can you:
 *
 *   npm run booklet:check
 *
 * Needs `typst` on the PATH, or `TYPST_BIN` set. Writes the PDFs to
 * `BOOKLET_CHECK_OUT` when set, for a look at the result.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PDFDocument } from '@cantoo/pdf-lib'
import { LAYOUTS, PAPERS, bookletData, bookletFilename, imposeBookletPdf, typesetBooklet } from '../services/booklet.js'
import { Discipline } from '../generated/graphql.js'
import fixture from './booklet-fixture.json' with { type: 'json' }

import type { BookletOptions, BookletSources } from '../services/booklet.js'

const bin = process.env.TYPST_BIN ?? 'typst'
const outDir = process.env.BOOKLET_CHECK_OUT
const now = new Date('2026-01-01T00:00:00Z')

// the fixture's messages are a copy of the site's, plus a translated label as
// the ui-messages collection would supply it
const sources: BookletSources = {
  ...(fixture as BookletSources),
  messages: {
    ...fixture.messages,
    'home.level': 'Nivå {level}'
  }
}

const cases: BookletOptions[] = []
for (const layout of LAYOUTS) {
  for (const paper of PAPERS) {
    for (const detailed of [false, true]) {
      cases.push({
        discipline: Discipline.SingleRope,
        paper,
        lang: detailed ? 'sv' : 'en',
        detailed,
        rulesId: detailed ? 'ijru@5.0.0' : null,
        layout,
        isbn: layout === 'print' && !detailed ? '978-91-8000-000-0' : null,
        printedBy: layout === 'print' && !detailed ? 'Example Print Shop AB' : null
      })
    }
  }
}

let failed = false
for (const options of cases) {
  const filename = bookletFilename(options)
  try {
    const data = bookletData(options, sources, { now })
    let pdf = await typesetBooklet(data, { bin, now })
    const pages = (await PDFDocument.load(pdf)).getPageCount()
    if (pages < 4) throw new Error(`only ${pages} pages`)
    if (pages % data.padToMultipleOf !== 0) throw new Error(`${pages} pages, not a multiple of ${data.padToMultipleOf}`)
    let sides = pages
    if (options.layout === 'booklet') {
      pdf = await imposeBookletPdf(pdf, options.paper)
      sides = (await PDFDocument.load(pdf)).getPageCount()
      if (sides !== pages / 2) throw new Error(`${pages} pages imposed onto ${sides} sides`)
    }
    if (outDir) {
      await mkdir(outDir, { recursive: true })
      await writeFile(path.join(outDir, filename), pdf)
    }
    console.log(`ok   ${filename} (${pages} pages${sides !== pages ? `, ${sides} sides` : ''}, ${Math.round(pdf.byteLength / 1024)} kB)`)
  } catch (err) {
    failed = true
    console.error(`FAIL ${filename}`)
    console.error(err)
    if (typeof err === 'object' && err !== null && 'stderr' in err) console.error(err.stderr)
  }
}

process.exit(failed ? 1 : 0)
