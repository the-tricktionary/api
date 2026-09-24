/**
 * Fails on a query or mutation without `@requiresScopes`, as the API does on startup
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
