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
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  // Not a secret either, it is handed out to search clients
  ALGOLIA_APP_ID: z.string(),
  PORT: z.coerce.number().default(3000),
  // The origin a Mux direct upload is created for when the request's own
  // origin isn't one we allow
  MUX_UPLOAD_CORS_ORIGIN: z.url().default('https://admin.the-tricktionary.com'),
  // The publicly readable Cloud Storage bucket timing track audio is uploaded to
  TIMING_TRACK_BUCKET: z.string().default('tricktionary-timing-tracks'),
  // The public site, whose sitemap this serves, and whose English interface
  // messages the booklets are labelled with
  WEB_URL: z.url().default('https://the-tricktionary.com'),
  // Linked to from the admin digest
  ADMIN_URL: z.url().default('https://admin.the-tricktionary.com'),
  // A job's crontab schedule in UTC, for its Sentry cron monitor
  JOB_SCHEDULE: z.string().optional(),
  // Set by Cloud Run in jobs
  CLOUD_RUN_EXECUTION: z.string().optional(),
  // The Typst binary that typesets booklets, see the README
  TYPST_BIN: z.string().default('typst'),
  // `report` logs what access control denies instead of denying it
  ACCESS_CONTROL: z.enum(['enforce', 'report']).default('enforce')
})

export const {
  SENTRY_DSN,
  GITHUB_SHA,
  GITHUB_REF,
  GOOGLE_CLOUD_PROJECT,
  ALGOLIA_APP_ID,
  PORT,
  MUX_UPLOAD_CORS_ORIGIN,
  TIMING_TRACK_BUCKET,
  WEB_URL,
  ADMIN_URL,
  JOB_SCHEDULE,
  CLOUD_RUN_EXECUTION,
  TYPST_BIN,
  ACCESS_CONTROL
} = envSchema.parse(process.env)
