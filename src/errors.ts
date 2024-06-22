import { GraphQLError, type GraphQLErrorExtensions } from 'graphql'
import type { ZodIssue } from 'zod'

interface CustomErrorOptions<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> {
  /** Should be the same as the extended error type */
  name: string
  /**
   * let's you provide the original error that caused this error to be thrown
   */
  cause?: Error | any
  /**
   * an error code using ALL_CAPS_SNAKE_CASE, this might be used for i18n on
   * the client's end
   */
  code: string
  httpStatusCode: number
  /**
   * Public extra information that will be sent to the client
   */
  extensions?: Extensions & GraphQLErrorExtensions
  /**
   * Private information that will only be added to server logs
   */
  private?: Private
  /**
   * Allows overwriting the error stack, useful if you're just transforming
   * an error from an external library or the likes.
   */
  stack?: string
}

type ExtendedErrorOptions<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> = Omit<CustomErrorOptions<Extensions, Private>, 'name' | 'code' | 'httpStatusCode'>

export class CustomError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends GraphQLError {
  private?: Record<string, any>

  constructor (errOrMsg: string | Error, options: CustomErrorOptions<Extensions, Private>) {
    super(typeof errOrMsg === 'string' ? errOrMsg : errOrMsg.message, {
      extensions: {
        ...(options.extensions ?? {}),
        http: { status: options.httpStatusCode },
        code: options.code
      }
    })
    this.name = options.name
    this.cause = errOrMsg instanceof Error ? errOrMsg : options.cause
    this.private = options.private
    if (options.stack != null) this.stack = options.stack
    else if (errOrMsg instanceof Error && errOrMsg.stack != null) this.stack = errOrMsg.stack
  }
}

// ----------
// 4xx Errors
// ----------

/** Failed to validate input data */
export class ValidationError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions & { issues?: ZodIssue[] }, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions & { issues?: ZodIssue[] }, Private> = {}) {
    super(errorOrMsg, {
      name: 'ValidationError',
      code: 'BAD_USER_INPUT',
      httpStatusCode: 400,
      ...options
    })
  }
}

/** Failures such as invalid JWT, missing jwt, bad signature */
export class AuthenticationError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'AuthenticationError',
      code: 'AUTHENTICATION_FAILED',
      httpStatusCode: 401,
      ...options
    })
  }
}

/**
 * The authentication succeeded but the requester does not have the
 * required permission(s)
 */
export class AuthorizationError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions, Private> {
  constructor (errorOrMsg: string | Error = 'You are not allowed to perform this action, or you are not logged in', options: ExtendedErrorOptions<Extensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'AuthorizationError',
      code: 'AUTHORIZATION_FAILED',
      httpStatusCode: 403,
      ...options
    })
  }
}

interface NotFoundErrorExtensions { id: any, entity: string }

/** The requested entity could not be found */
export class NotFoundError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions & NotFoundErrorExtensions, Private> {
  constructor (errorOrMsg: string | Error = 'The requested entity was not found', options: ExtendedErrorOptions<Extensions & NotFoundErrorExtensions, Private>) {
    super(errorOrMsg, {
      name: 'NotFoundError',
      code: 'ENTITY_NOT_FOUND',
      httpStatusCode: 404,
      ...options
    })
  }
}

interface CollisionErrorExtensions { id: any, entity: string }
/**
 * The entity already exists and the operation would conflict with its existing
 * state. Alternatively there already exists an entity with the constraints
 * required to create/update an entity.
 */
export class CollisionError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions & CollisionErrorExtensions, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions & CollisionErrorExtensions, Private>) {
    super(errorOrMsg, {
      name: 'CollisionError',
      code: 'ENTITY_COLLISION',
      httpStatusCode: 409,
      ...options
    })
  }
}

export class ForceRequiredError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions & CollisionErrorExtensions, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions & CollisionErrorExtensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'ForceRequiredError',
      code: 'FORCE_REQUIRED',
      httpStatusCode: 409,
      ...options
    })
  }
}

/**
 * Useful to signify the resolver has been removed and won't return. Good
 * for logging/metrics tracking to find things still using the resolver.
 */
export class ResolverRemovedError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions, Private> {
  constructor (errorOrMsg: string | Error = 'This feature has been removed', options: ExtendedErrorOptions<Extensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'ResolverRemovedError',
      code: 'RESOLVER_REMOVED',
      httpStatusCode: 410,
      ...options
    })
  }
}

// ----------
// 5xx Errors
// ----------

/**
 * Used for unhandled errors, should generally not be used outside the error
 * formatter.
 */
export class UnexpectedError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'UnexpectedError',
      code: 'INTERNAL_SERVER_ERROR', // Standard Apollo error code
      httpStatusCode: 500,
      ...options
    })
  }
}

/**
 * The resolver for the requested function is currently not implemented, but may
 * be in the future.
 */
export class NotImplementedError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions, Private> {
  constructor (errorOrMsg: string | Error = 'This feature is not (yet?) implemented', options: ExtendedErrorOptions<Extensions, Private> = {}) {
    super(errorOrMsg, {
      name: 'NotImplementedError',
      code: 'OPERATION_RESOLUTION_FAILURE', // Standard Apollo error code
      httpStatusCode: 501,
      ...options
    })
  }
}

interface UpstreamErrorExtensions { upstream: string }
/** Unexpected errors caused by upstream services */
export class UpstreamError<Extensions extends Record<string, any> | undefined, Private extends Record<string, any> | undefined> extends CustomError<Extensions & UpstreamErrorExtensions, Private> {
  constructor (errorOrMsg: string | Error, options: ExtendedErrorOptions<Extensions & UpstreamErrorExtensions, Private>) {
    super(errorOrMsg, {
      name: 'UpstreamError',
      code: 'DEPENDENCY_FAILED',
      httpStatusCode: 502,
      ...options
    })
  }
}
