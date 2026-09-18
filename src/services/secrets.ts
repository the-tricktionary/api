import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { GCP_PROJECT, GSM_LOCATION } from '../config.js'

/**
 * The secrets the API reads at runtime.
 *
 * A name is both the Secret Manager secret ID and, prefixed with `GSM_`, the
 * environment variable that overrides it, so there is no mapping table that can
 * drift out of sync with either side.
 */
export const SECRET_NAMES = [
  'STRIPE_SK',
  'ALGOLIA_API_KEY',
  'MUX_TOKEN_ID',
  'MUX_TOKEN_SECRET',
  'MUX_WEBHOOK_SECRET'
] as const

export type SecretName = typeof SECRET_NAMES[number]

/** The environment variable that overrides a secret, for local development */
function overrideVariable (name: SecretName) { return `GSM_${name}` }

// Built on first use, so an environment that overrides every secret never has
// to talk to Secret Manager, or have credentials that are allowed to
let client: SecretManagerServiceClient | undefined
function secretManager () {
  // A global secret is readable from every region, only a secret that has to be
  // *stored* in one (data residency) is addressed through a regional endpoint.
  client ??= new SecretManagerServiceClient(GSM_LOCATION != null
    ? { apiEndpoint: `secretmanager.${GSM_LOCATION}.rep.googleapis.com` }
    : {})
  return client
}

async function secretVersionName (name: SecretName) {
  // getProjectId falls back to the application default credentials and the
  // metadata server, which is how this resolves on Cloud Run
  const project = GCP_PROJECT ?? await secretManager().getProjectId()
  return GSM_LOCATION != null
    ? `projects/${project}/locations/${GSM_LOCATION}/secrets/${name}/versions/latest`
    : `projects/${project}/secrets/${name}/versions/latest`
}

// Both sources are trimmed: a trailing newline is easy to get into a `.env`
// file and into a secret created from one, none of these values can
// meaningfully end in whitespace, and the two sources have to agree or local
// development stops predicting production.
async function fetchSecret (name: SecretName): Promise<string> {
  const override = process.env[overrideVariable(name)]?.trim()
  if (override != null && override !== '') return override

  const versionName = await secretVersionName(name)
  let value: string
  try {
    const [version] = await secretManager().accessSecretVersion({ name: versionName })
    const payload = version.payload?.data
    value = (payload == null ? '' : Buffer.from(payload as Uint8Array).toString('utf8')).trim()
  } catch (err) {
    throw new Error(
      `Could not read ${versionName}. Either set ${overrideVariable(name)} in the environment, or make sure the ` +
      'secret exists and the service account has roles/secretmanager.secretAccessor on it.',
      { cause: err }
    )
  }
  if (value === '') throw new Error(`${versionName} has an empty payload`)
  return value
}

const secrets = new Map<SecretName, Promise<string>>()

/**
 * The value of a secret, taken from `GSM_<name>` in the environment when that
 * is set and from the latest Secret Manager version otherwise.
 *
 * The modules that need a secret read it while they are evaluated, so a secret
 * we cannot read stops the process from starting rather than failing the first
 * request that needs it.
 *
 * A resolved value is kept for the lifetime of the process, so a rotated secret
 * is only picked up by a new instance.
 */
export async function getSecret (name: SecretName): Promise<string> {
  let pending = secrets.get(name)
  if (pending == null) {
    pending = fetchSecret(name)
    secrets.set(name, pending)
  }

  try {
    return await pending
  } catch (err) {
    if (secrets.get(name) === pending) secrets.delete(name)
    throw err
  }
}
