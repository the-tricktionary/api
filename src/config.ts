import { initializeApp, applicationDefault } from 'firebase-admin/app'
import z from 'zod'

// Load a local .env file if there is one (Node >= 20.12 has this built in, so
// no need for dotenv). Variables already set in the environment take
// precedence, just like with dotenv.
try {
  process.loadEnvFile()
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
}

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://project-5641153190345267944.firebaseio.com'
})

// Configuration only. Secrets are read through `services/secrets`, which takes
// them from Secret Manager, or from `GSM_<name>` in the environment.
const envSchema = z.object({
  // Not a secret, a Sentry DSN is public by design. It also has to be available
  // synchronously, `tracing` initialises Sentry before the instrumented
  // libraries are imported.
  SENTRY_DSN: z.string().optional(),
  GITHUB_SHA: z.string().optional(),
  GITHUB_REF: z.string().optional(),
  GCP_PROJECT: z.string().optional(),
  // Not a secret either, it is handed out to search clients
  ALGOLIA_APP_ID: z.string(),
  PORT: z.coerce.number().default(3000),
  // The origin a Mux direct upload is created for when the request's own
  // origin isn't one we allow
  MUX_UPLOAD_CORS_ORIGIN: z.url().default('https://admin.the-tricktionary.com')
})

export const {
  SENTRY_DSN,
  GITHUB_SHA,
  GITHUB_REF,
  GCP_PROJECT,
  ALGOLIA_APP_ID,
  PORT,
  MUX_UPLOAD_CORS_ORIGIN
} = envSchema.parse(process.env)
