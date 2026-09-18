import Mux from '@mux/mux-node'
import { MUX_TOKEN_ID, MUX_TOKEN_SECRET } from '../config'

/** Mux hosts the trick videos, see https://docs.mux.com */
export const mux = new Mux({ tokenId: MUX_TOKEN_ID, tokenSecret: MUX_TOKEN_SECRET })

/**
 * The origin a direct upload is created for when the request doesn't come from
 * an origin we know, the admin frontend being the only place uploads start.
 */
export const DEFAULT_UPLOAD_CORS_ORIGIN = 'https://admin.the-tricktionary.com'
