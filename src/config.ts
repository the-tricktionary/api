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

const envSchema = z.object({
  SENTRY_DSN: z.string().optional(),
  GITHUB_SHA: z.string().optional(),
  GITHUB_REF: z.string().optional(),
  GCP_PROJECT: z.string().optional(),
  STRIPE_SK: z.string(),
  ALGOLIA_APP_ID: z.string(),
  ALGOLIA_API_KEY: z.string(),
  PORT: z.coerce.number().default(3000),
  // Mux hosts the trick videos: the token is used for direct uploads and for
  // managing assets, the webhook secret verifies the events Mux sends us
  MUX_TOKEN_ID: z.string(),
  MUX_TOKEN_SECRET: z.string(),
  MUX_WEBHOOK_SECRET: z.string()
})

export const {
  SENTRY_DSN,
  GITHUB_SHA,
  GITHUB_REF,
  GCP_PROJECT,
  STRIPE_SK,
  ALGOLIA_APP_ID,
  ALGOLIA_API_KEY,
  PORT,
  MUX_TOKEN_ID,
  MUX_TOKEN_SECRET,
  MUX_WEBHOOK_SECRET
} = envSchema.parse(process.env)
