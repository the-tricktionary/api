import { Timestamp } from '@google-cloud/firestore'
import { GraphQLScalarType, Kind } from 'graphql'

export const TimestampScalar = new GraphQLScalarType({
  name: 'Timestamp',
  description: 'The `Timestamp` scalar represents a UNIX epoch timestamp in milliseconds',
  serialize (value: Timestamp) {
    return value.toMillis()
  },
  parseValue (value: number) {
    return Timestamp.fromMillis(value)
  },
  parseLiteral (ast) {
    if (ast.kind === Kind.INT) {
      return Timestamp.fromMillis(parseInt(ast.value, 10))
    }
    return null
  }
})
