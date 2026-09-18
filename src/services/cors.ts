/**
 * The origins the API talks to: the Tricktionary itself, the firebase preview
 * channels of its two frontends, and localhost for development. Shared by the
 * CORS middleware and by the Mux direct uploads, whose signed upload URL only
 * accepts a browser upload from the origin it was created for.
 */
export const allowedOrigins = [
  /^https:\/\/([a-z0-9-]+\.)*the-tricktionary\.com$/,
  /^https:\/\/tricktionary-(v4|admin)--.+\.web\.app$/,
  /^https?:\/\/localhost(:\d+)?$/
]

/** Whether `origin` is one of the {@link allowedOrigins} */
export function isAllowedOrigin (origin: string | undefined | null): origin is string {
  return typeof origin === 'string' && allowedOrigins.some(allowed => allowed.test(origin))
}
