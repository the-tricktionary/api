import { randomUUID } from 'node:crypto'
import { Storage } from '@google-cloud/storage'
import { Timestamp } from '@google-cloud/firestore'
import { TIMING_TRACK_BUCKET } from '../config.js'

/**
 * Timing track audio lives in a Cloud Storage bucket that allows public reads,
 * so athletes' browsers can stream it straight from storage. Uploads go
 * through V4 signed URLs the API hands out to speed editors, the same shape as
 * the Mux direct uploads: the API never sees the file itself.
 *
 * The bucket needs a CORS rule that allows PUT with a Content-Type header from
 * the admin origin, see the README.
 */

/** Only formats every current browser can play, canonical type to file extension */
export const TIMING_TRACK_CONTENT_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac'
}

/**
 * The same formats under the other names browsers and operating systems give
 * them: a wav picked on Windows often arrives as audio/vnd.wave, an m4a as
 * audio/x-m4a. They name a format we already accept, so they are no reason to
 * refuse the file. The upload is still signed for the name the uploader sent,
 * since that is the Content-Type it will PUT, and only the extension we store
 * the object under comes from the canonical name.
 */
export const TIMING_TRACK_CONTENT_TYPE_ALIASES: Record<string, string> = {
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/vnd.wave': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/x-pn-wav': 'audio/wav',
  'audio/x-flac': 'audio/flac'
}

/**
 * The name we know a content type by, or null when it is not a format we take.
 * Parameters and casing are not part of the name, a browser may send either.
 */
export function canonicalTimingTrackContentType (contentType: string): string | null {
  const name = contentType.split(';')[0].trim().toLowerCase()
  const canonical = TIMING_TRACK_CONTENT_TYPE_ALIASES[name] ?? name
  return canonical in TIMING_TRACK_CONTENT_TYPES ? canonical : null
}

/** 50 MB is a few times the largest lossless three minute track */
export const TIMING_TRACK_MAX_BYTES = 50 * 1024 * 1024
const UPLOAD_URL_LIFETIME_MS = 15 * 60 * 1000

const OBJECT_PREFIX = 'event-definitions'

let storage: Storage | undefined
function bucket () {
  storage ??= new Storage()
  return storage.bucket(TIMING_TRACK_BUCKET)
}

export function timingTrackPublicUrl (objectName: string) {
  return `https://storage.googleapis.com/${TIMING_TRACK_BUCKET}/${objectName.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The object name behind one of our public URLs, or null when the URL points
 * anywhere else. This is what makes an audioUrl an admin sends back
 * trustworthy: it can only ever name an object in our own bucket and prefix.
 */
export function timingTrackObjectName (audioUrl: string, eventDefinitionId: string): string | null {
  let url: URL
  try {
    url = new URL(audioUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') return null
  const [, bucketName, ...parts] = url.pathname.split('/')
  if (bucketName !== TIMING_TRACK_BUCKET) return null
  const objectName = parts.map(decodeURIComponent).join('/')
  return objectName.startsWith(`${OBJECT_PREFIX}/${eventDefinitionId}/`) ? objectName : null
}

export async function createTimingTrackUpload (eventDefinitionId: string, contentType: string) {
  const canonical = canonicalTimingTrackContentType(contentType)
  if (canonical == null) throw new RangeError(`Unsupported content type ${contentType}`)
  const extension = TIMING_TRACK_CONTENT_TYPES[canonical]

  const objectName = `${OBJECT_PREFIX}/${eventDefinitionId}/${randomUUID()}.${extension}`
  const expires = Date.now() + UPLOAD_URL_LIFETIME_MS
  const [url] = await bucket().file(objectName).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires,
    contentType,
    // the uploader has to send this header too, which caps the file size
    extensionHeaders: { 'x-goog-content-length-range': `0,${TIMING_TRACK_MAX_BYTES}` }
  })

  return { url, audioUrl: timingTrackPublicUrl(objectName), expiresAt: Timestamp.fromMillis(expires) }
}

/** Best effort, a missing object is not an error */
export async function deleteTimingTrackObject (objectName: string) {
  await bucket().file(objectName).delete({ ignoreNotFound: true })
}
