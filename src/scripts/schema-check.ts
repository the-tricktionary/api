/**
 * Fails when a query or mutation lacks `@requiresScopes`, which the API also
 * refuses to start with, so that CI catches it before a deploy does
 *
 * Usage:
 *   npm run schema:check
 */
import { makeExecutableSchema } from '@graphql-tools/schema'
import typeDefs from '../schema.js'
import { assertRootFieldsScoped, scopeRequirements } from '../helpers/scopes.js'

const schema = makeExecutableSchema({ typeDefs })
assertRootFieldsScoped(schema, scopeRequirements(schema))
process.stdout.write('Every query and mutation says which scopes it requires\n')
