import { AuthenticationError } from 'apollo-server'
import { UserDoc } from '../store/schema'

export function allowUser (user?: UserDoc) {
  function enrich (checkMethod: () => boolean) {
    const annotations = {
      assert: (message?: string) => {
        if (!checkMethod()) {
          console.info(`User ${user?.id} assertion ${checkMethod.name} failed ${message ? `message: ${message}` : ''}`)
          throw new AuthenticationError(`Permission denied ${message ? ': ' + message : ''}`)
        }
        return true
      }
    }
    return Object.assign(checkMethod, annotations)
  }

  return {
    getTricks: enrich(() => true)
  }
}
