/**
 * Shared by the CORS middleware and by the Mux direct uploads, whose signed
 * upload URL only accepts a browser upload from the origin it was created for.
 */
export const allowedOrigins = [
  /^https:\/\/([a-z0-9-]+\.)*the-tricktionary\.com$/,
  /^https:\/\/tricktionary-(v4|admin)--.+\.web\.app$/,
  /^https?:\/\/localhost(:\d+)?$/
]

export function isAllowedOrigin (origin: string | undefined): origin is string {
  return typeof origin === 'string' && allowedOrigins.some(allowed => allowed.test(origin))
}
