import { ApolloError } from 'apollo-server'
import type { ApolloServerPlugin } from 'apollo-server-plugin-base'
import * as Sentry from '@sentry/node'

// from: https://blog.sentry.io/2020/07/22/handling-graphql-errors-using-sentry

const sentryPlugin: ApolloServerPlugin = {
  requestDidStart (_) {
    /* Within this returned object, define functions that respond to
       request-specific lifecycle events. */
    return {
      async willSendResponse () {
        Sentry.getCurrentHub().getScope()?.getTransaction()?.finish()
        await Sentry.flush(2000)
      },
      didResolveOperation ({ request, document, operationName }) {
        console.log(operationName)
        if (operationName !== 'IntrospectionQuery') {
          const transaction = Sentry.startTransaction({ name: operationName ?? 'GraphQL Query', op: 'transaction' })
          Sentry.configureScope(scope => scope.setSpan(transaction))
        }
      },
      // executionDidStart () {
      //   return {
      //     willResolveField ({ source, args, context, info }) {
      //       console.log(info)
      //       return () => {
      //         console.log('done')
      //       }
      //     }

      //   }
      // },
      didEncounterErrors (ctx) {
        // If we couldn't parse the operation, don't
        // do anything here
        if (!ctx.operation) {
          return
        }

        for (const err of ctx.errors) {
          // Only report internal server errors,
          // all errors extending ApolloError should be user-facing
          if (err instanceof ApolloError) {
            continue
          }

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
                level: Sentry.Severity.Debug
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
