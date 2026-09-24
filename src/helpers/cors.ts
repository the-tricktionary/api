const localhost = /^https?:\/\/localhost(:\d+)?$/

/** The public site, its Hosting preview channels and local development */
export const webOrigins = [
  /^https:\/\/(www\.)?the-tricktionary\.com$/,
  /^https:\/\/tricktionary-v4--.+\.web\.app$/,
  localhost
]

/** The admin interface, its Hosting preview channels and local development */
export const adminOrigins = [
  /^https:\/\/admin\.the-tricktionary\.com$/,
  /^https:\/\/tricktionary-admin--.+\.web\.app$/,
  localhost
]

/**
 * The Tricktionary's own apps. Mux direct uploads are made from them, and a
 * signed upload URL only accepts a browser upload from the origin it was
 * created for.
 */
export const allowedOrigins = [...webOrigins, ...adminOrigins]

export function isAllowedOrigin (origin: string | undefined): origin is string {
  return typeof origin === 'string' && allowedOrigins.some(allowed => allowed.test(origin))
}
