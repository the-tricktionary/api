import type { ApolloServerPlugin } from '@apollo/server'
import * as Sentry from '@sentry/node'

// from: https://blog.sentry.io/2020/07/22/handling-graphql-errors-using-sentry

const sentryPlugin: ApolloServerPlugin = {
  async requestDidStart (_) {
    /* Within this returned object, define functions that respond to
       request-specific lifecycle events. */
    return {
      async willSendResponse () {
        await Sentry.flush(2000)
      },
      async didEncounterErrors (ctx) {
        // If we couldn't parse the operation, don't
        // do anything here
        if (!ctx.operation) {
          return
        }

        for (const err of ctx.errors) {
          // Add scoped report details and send to Sentry
          Sentry.withScope(scope => {
            // Annotate whether failing operation was query/mutation/subscription
            scope.setTag('kind', ctx.operation?.operation)

            // Log query and variables as extras (make sure to strip out sensitive data!)
            scope.setExtra('query', ctx.request.query)
            scope.setExtra('variables', ctx.request.variables)

            if (err.path) {
              // We can also add the path as breadcrumb
              scope.addBreadcrumb({
                category: 'query-path',
                message: err.path.join(' > '),
                level: 'debug'
              })
            }

            Sentry.captureException(err)
          })
        }
      }
    }
  }
}

export default sentryPlugin
