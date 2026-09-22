import { GOOGLE_CLOUD_PROJECT } from '../config.js'
import { logger } from '../services/logger.js'

import type { Request } from 'express'
import type pino from 'pino'

/**
 * Cloud Logging's fields for the trace in Cloud Run's `X-Cloud-Trace-Context`,
 * `TRACE_ID/SPAN_ID;o=SAMPLED` with the span ID in decimal
 */
export function cloudTraceFields (header: string | undefined, project = GOOGLE_CLOUD_PROJECT) {
  const match = header != null ? /^([0-9a-f]{32})(?:\/(\d+))?(?:;o=([01]))?/i.exec(header) : null
  if (!project || !match?.[1]) return {}
  const [, traceId, spanId, sampled] = match

  return {
    'logging.googleapis.com/trace': `projects/${project}/traces/${traceId.toLowerCase()}`,
    ...(spanId ? { 'logging.googleapis.com/spanId': BigInt(spanId).toString(16).padStart(16, '0') } : {}),
    ...(sampled ? { 'logging.googleapis.com/trace_sampled': sampled === '1' } : {})
  }
}

/** Grouped under the request's trace in Cloud Logging */
export function requestLogger (req: Pick<Request, 'get'>, bindings: pino.Bindings = {}) {
  return logger.child({ ...cloudTraceFields(req.get('X-Cloud-Trace-Context')), ...bindings })
}
