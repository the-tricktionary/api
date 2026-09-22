import { TYPST_BIN, WEB_URL } from '../config.js'
import { sendError } from '../helpers/httpErrors.js'
import { bookletOptionsSchema, renderBooklet } from '../services/booklet.js'
import { requestLogger } from '../helpers/requestLogger.js'
import { createDataSources } from '../store/firestoreDataSource.js'

import type { RequestHandler } from 'express'

/**
 * `GET /booklets/tricks.pdf`, a printable list of a discipline's tricks, see
 * `bookletOptionsSchema` for the query string. The public site's Firebase
 * Hosting config rewrites `/booklets/*.pdf` here, and Hosting's CDN caches
 * each combination of query parameters by the `Cache-Control` below, so a
 * booklet is only typeset when nobody asked for that one lately.
 */
export const bookletHandler: RequestHandler = async (req, res) => {
  const logger = requestLogger(req, { name: 'booklet' })

  const parsed = bookletOptionsSchema.safeParse(req.query)
  if (!parsed.success) {
    sendError(req, res, parsed.error, { logger })
    return
  }

  let pdf: Uint8Array
  let filename: string
  try {
    ({ pdf, filename } = await renderBooklet(parsed.data, { dataSources: createDataSources(), logger, webUrl: WEB_URL, bin: TYPST_BIN }))
  } catch (err) {
    sendError(req, res, err, { logger })
    return
  }

  res.set('content-type', 'application/pdf')
  res.set('content-disposition', `inline; filename="${filename}"`)
  res.set('cache-control', 'public, max-age=3600, s-maxage=86400')
  res.status(200).send(Buffer.from(pdf))
}
