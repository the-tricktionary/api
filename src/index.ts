import { PORT } from './config'
import { server } from './apollo'

server.listen(PORT)
  .then(({ url }) => {
    console.log(`🚀 Server ready at ${url}`)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
