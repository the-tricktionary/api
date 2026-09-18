import Mux from '@mux/mux-node'
import { MUX_TOKEN_ID, MUX_TOKEN_SECRET } from '../config'
import { VideoUploadStatus } from '../generated/graphql'

export const mux = new Mux({ tokenId: MUX_TOKEN_ID, tokenSecret: MUX_TOKEN_SECRET })

/** The statuses an upload never leaves again */
export const FINAL_UPLOAD_STATUSES = [VideoUploadStatus.Ready, VideoUploadStatus.Errored, VideoUploadStatus.Cancelled]
