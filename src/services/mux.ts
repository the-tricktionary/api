import Mux from '@mux/mux-node'
import { getSecret } from './secrets.js'
import { VideoUploadStatus } from '../generated/graphql.js'

const [tokenId, tokenSecret] = await Promise.all([getSecret('tricktionary-api-mux-token-id'), getSecret('tricktionary-api-mux-token-secret')])

export const mux = new Mux({ tokenId, tokenSecret })

export const FINAL_UPLOAD_STATUSES = [VideoUploadStatus.Ready, VideoUploadStatus.Errored, VideoUploadStatus.Cancelled]
