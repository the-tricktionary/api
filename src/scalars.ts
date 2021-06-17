import { Timestamp } from '@google-cloud/firestore'
import { GraphQLScalarType, Kind } from 'graphql'

export const TimestampScalar = new GraphQLScalarType({
  name: 'Timestamp',
  description: 'The `Timestamp` scalar represents a UNIX epoch timestamp in milliseconds',
  serialize (value: Timestamp | { _seconds: number, _nanoseconds: number }) {
    return Timestamp.prototype.toMillis.call(value)
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
