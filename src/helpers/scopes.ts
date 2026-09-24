import { getDirective, MapperKind, mapSchema } from '@graphql-tools/utils'
import { getNamedType, GraphQLObjectType, isObjectType, Kind, TypeInfo, visit, visitWithTypeInfo } from 'graphql'

import type { DirectableGraphQLObject } from '@graphql-tools/utils'
import type { DocumentNode, FragmentDefinitionNode, GraphQLSchema, OperationDefinitionNode } from 'graphql'
import type { Scope } from '../generated/graphql.js'

/**
 * What `@requiresScopes` asks for: any one of the lists, holding every scope
 * in it. `[[a, b], [c]]` is a and b, or c.
 */
export type ScopeRequirement = ReadonlyArray<readonly Scope[]>

/** A field and every requirement it comes with, all of which have to hold */
export type ScopeRequirements = ReadonlyMap<string, readonly ScopeRequirement[]>

export interface ScopeViolation {
  /** `Type.field` */
  field: string
  requires: ScopeRequirement
}

const DIRECTIVE = 'requiresScopes'

export function holdsScopes (scopes: ReadonlySet<Scope>, requirement: ScopeRequirement) {
  return requirement.some(all => all.every(scope => scopes.has(scope)))
}

function requirementOf (schema: GraphQLSchema, node: DirectableGraphQLObject): ScopeRequirement | undefined {
  return getDirective(schema, node, DIRECTIVE)?.[0]?.scopes as ScopeRequirement | undefined
}

/**
 * Every object field's requirements by `Type.field`: its own, its type's and
 * the type it returns. A field missing from the map requires nothing.
 */
export function scopeRequirements (schema: GraphQLSchema): ScopeRequirements {
  const requirements = new Map<string, ScopeRequirement[]>()
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith('__')) continue
    const ofType = requirementOf(schema, type)
    for (const field of Object.values(type.getFields())) {
      const fieldRequirements = [
        requirementOf(schema, field),
        ofType,
        requirementOf(schema, getNamedType(field.type))
      ].filter(requirement => requirement != null)
      if (fieldRequirements.length > 0) requirements.set(`${type.name}.${field.name}`, fieldRequirements)
    }
  }
  return requirements
}

/**
 * Every query and mutation has to say which scopes it needs, so a new one
 * isn't open to every client because it was forgotten
 */
export function assertRootFieldsScoped (schema: GraphQLSchema, requirements: ScopeRequirements) {
  const unscoped = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
    .filter(type => type != null)
    .flatMap(type => Object.keys(type.getFields()).map(field => `${type.name}.${field}`))
    .filter(field => !requirements.has(field))
  if (unscoped.length > 0) throw new Error(`Every query and mutation needs @${DIRECTIVE}, these have none: ${unscoped.join(', ')}`)
}

export function describeScopeRequirement (requirement: ScopeRequirement) {
  const options = requirement.map(all => all.map(scope => `\`${scope}\``).join(' and '))
  const list = options.length > 1 ? `${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}` : options[0]
  return `Requires the ${list} scope${requirement.some(all => all.length > 1) ? 's' : ''}.`
}

function withRequirements (description: string | null | undefined, requirements: readonly ScopeRequirement[]) {
  return [description, ...requirements.map(describeScopeRequirement)].filter(Boolean).join('\n\n')
}

/**
 * Introspection doesn't show where directives are used, so the requirements
 * are written into the descriptions: a type's on the type, and on a field its
 * own and those of the type it returns.
 */
export function describeScopes (schema: GraphQLSchema) {
  return mapSchema(schema, {
    [MapperKind.OBJECT_TYPE] (type) {
      const requirement = requirementOf(schema, type)
      if (requirement == null) return type
      return new GraphQLObjectType({ ...type.toConfig(), description: withRequirements(type.description, [requirement]) })
    },
    [MapperKind.OBJECT_FIELD] (fieldConfig) {
      const requirements = [
        requirementOf(schema, fieldConfig),
        requirementOf(schema, getNamedType(fieldConfig.type))
      ].filter(requirement => requirement != null)
      if (requirements.length === 0) return fieldConfig
      return { ...fieldConfig, description: withRequirements(fieldConfig.description, requirements) }
    }
  })
}

/**
 * The fields an operation selects, through the fragments it spreads, whose
 * requirements the scopes don't meet. Scopes depend only on the client, so
 * the document alone decides, before anything is resolved.
 */
export function scopeViolations (schema: GraphQLSchema, requirements: ScopeRequirements, document: DocumentNode, operation: OperationDefinitionNode, scopes: ReadonlySet<Scope>): ScopeViolation[] {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition)
  }

  const violations = new Map<string, ScopeViolation>()
  const visited = new Set<string>()
  const pending: Array<OperationDefinitionNode | FragmentDefinitionNode> = [operation]
  const typeInfo = new TypeInfo(schema)
  const visitor = visitWithTypeInfo(typeInfo, {
    Field () {
      const parent = typeInfo.getParentType()
      const field = typeInfo.getFieldDef()
      if (parent == null || field == null) return
      const key = `${parent.name}.${field.name}`
      if (violations.has(key)) return
      const unmet = requirements.get(key)?.find(requirement => !holdsScopes(scopes, requirement))
      if (unmet != null) violations.set(key, { field: key, requires: unmet })
    },
    FragmentSpread (node) {
      const name = node.name.value
      const fragment = fragments.get(name)
      if (fragment != null && !visited.has(name)) {
        visited.add(name)
        pending.push(fragment)
      }
    }
  })

  for (let node = pending.pop(); node != null; node = pending.pop()) visit(node, visitor)
  return [...violations.values()]
}
