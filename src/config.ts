import * as dotenv from 'dotenv'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
import z from 'zod'
dotenv.config()

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
  PORT: z.coerce.number().default(3000)
})

export const {
  SENTRY_DSN,
  GITHUB_SHA,
  GITHUB_REF,
  GCP_PROJECT,
  STRIPE_SK,
  ALGOLIA_APP_ID,
  ALGOLIA_API_KEY,
  PORT = 3000
} = envSchema.parse(process.env)
