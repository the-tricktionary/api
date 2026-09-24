const localhost = /^https?:\/\/localhost(:\d+)?$/

/** The public site, its Hosting preview channels and local development */
export const webOrigins = [
  /^https:\/\/the-tricktionary\.com$/,
  /^https:\/\/tricktionary-v4--.+\.web\.app$/,
  localhost
]

/** The admin, its Hosting preview channels and local development */
export const adminOrigins = [
  /^https:\/\/admin\.the-tricktionary\.com$/,
  /^https:\/\/tricktionary-admin--.+\.web\.app$/,
  localhost
]

/** The API's own landing page, whose Apollo Sandbox calls from the page, and local development */
export const apiOrigins = [
  /^https:\/\/api\.the-tricktionary\.com$/,
  localhost
]

/** A Mux direct upload URL only accepts a browser upload from the origin it was created for */
export const allowedOrigins = [...webOrigins, ...adminOrigins]

export function isAllowedOrigin (origin: string | undefined): origin is string {
  return typeof origin === 'string' && allowedOrigins.some(allowed => allowed.test(origin))
}

/** A registered client's origin, which the whole origin has to match. Throws on an invalid expression. */
export function originPattern (source: string) {
  return new RegExp(`^(?:${source})$`)
}
