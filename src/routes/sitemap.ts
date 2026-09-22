import * as Sentry from '@sentry/node'
import { WEB_URL } from '../config.js'
import { firestore } from '../store/firestoreDataSource.js'
import { requestLogger } from '../helpers/requestLogger.js'
import { disciplineSlug } from '../helpers/disciplines.js'

import type { RequestHandler } from 'express'
import type { CollectionReference } from 'firebase-admin/firestore'
import type { TrickDoc } from '../store/schema.js'

/**
 * `GET /sitemap.xml`. The public site's Firebase Hosting config rewrites
 * `/sitemap.xml` here, so this is what crawlers see at
 * `https://the-tricktionary.com/sitemap.xml`.
 *
 * Reads every trick, so the `Cache-Control` below is what keeps a crawl from
 * being a full collection scan: Hosting's CDN honours it on a rewritten
 * response.
 */
export const sitemapHandler: RequestHandler = async (req, res) => {
  const logger = requestLogger(req, { name: 'sitemap' })

  let urls: string[]
  try {
    const qSnap = await (firestore.collection('tricks') as CollectionReference<TrickDoc>).get()

    urls = qSnap.docs.flatMap(dSnap => {
      const trick = dSnap.data()
      const slug = disciplineSlug(trick.discipline)
      // one unreadable document shouldn't cost us the whole sitemap
      if (slug == null) {
        logger.warn({ trickId: dSnap.id, discipline: trick.discipline }, 'Leaving a trick out of the sitemap, its discipline has no URL')
        return []
      }
      return [`${WEB_URL}/trick/${slug}/${encodeURIComponent(trick.slug)}`]
    })
  } catch (err) {
    logger.error(err, 'Could not build the sitemap')
    Sentry.captureException(err)
    res.status(500).send()
    return
  }

  res.set('content-type', 'application/xml')
  res.set('cache-control', 'public, max-age=3600, s-maxage=86400')
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>

<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(url => `  <url>
    <loc>${url}</loc>
    <changefreq>yearly</changefreq>
  </url>`).join('\n')}
</urlset>
`)
}
