import * as Sentry from '@sentry/node'
import z from 'zod'
import { fromZodError } from 'zod-validation-error'
import { TYPST_BIN, WEB_URL } from '../config.js'
import { NotFoundError } from '../errors.js'
import { DISCIPLINE_SLUGS, disciplineFromSlug } from '../helpers/disciplines.js'
import { LAYOUTS, PAPERS, isbnDigits, renderBooklet } from '../services/booklet.js'
import { logger as baseLogger } from '../services/logger.js'
import { TypstBusyError } from '../services/typst.js'
import { createDataSources } from '../store/firestoreDataSource.js'
import { langSchema, rulesIdSchema } from '../validation.js'

import type { RequestHandler } from 'express'

const flag = z.enum(['1', '0', 'true', 'false']).default('0').transform(value => value === '1' || value === 'true')

const querySchema = z.object({
  discipline: z.enum(DISCIPLINE_SLUGS).transform(disciplineFromSlug),
  paper: z.enum(PAPERS).default('a4'),
  lang: langSchema.default('en'),
  detailed: flag,
  rulesId: rulesIdSchema.optional().transform(rulesId => rulesId ?? null),
  layout: z.enum(LAYOUTS).default('pages'),
  // the print layout's colophon and barcode
  isbn: z.string().trim()
    .refine(isbn => isbnDigits(isbn) != null, 'An ISBN is 13 digits starting with 978 or 979, optionally with dashes, and its check digit has to add up')
    .optional().transform(isbn => isbn ?? null),
  printedBy: z.string().trim().max(200).optional().transform(printedBy => printedBy === undefined || printedBy === '' ? null : printedBy)
})

/**
 * `GET /booklets/tricks.pdf`, a printable list of a discipline's tricks. The
 * public site's Firebase Hosting config rewrites `/booklets/*.pdf` here, and
 * Hosting's CDN caches each combination of query parameters by the
 * `Cache-Control` below, so a booklet is only typeset when nobody asked for
 * that one lately. See the README for the parameters.
 */
export const bookletHandler: RequestHandler = async (req, res) => {
  const logger = baseLogger.child({ name: 'booklet' })

  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).type('text/plain').send(fromZodError(parsed.error).message)
    return
  }
  const options = parsed.data

  let pdf: Uint8Array
  let filename: string
  try {
    ({ pdf, filename } = await renderBooklet(options, { dataSources: createDataSources(), logger, webUrl: WEB_URL, bin: TYPST_BIN }))
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).type('text/plain').send(err.message)
      return
    }
    if (err instanceof TypstBusyError) {
      res.set('retry-after', '5')
      res.status(503).type('text/plain').send(err.message)
      return
    }
    logger.error(err, 'Could not typeset a booklet')
    Sentry.captureException(err)
    res.status(500).send()
    return
  }

  res.set('content-type', 'application/pdf')
  res.set('content-disposition', `inline; filename="${filename}"`)
  res.set('cache-control', 'public, max-age=3600, s-maxage=86400')
  res.status(200).send(Buffer.from(pdf))
}
