import { gql } from 'graphql-tag'

const typeDefs = gql`
  directive @cacheControl(
    maxAge: Int
    scope: CacheControlScope
    inheritMaxAge: Boolean
  ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION

  scalar Timestamp

  enum CacheControlScope {
    PUBLIC
    PRIVATE
  }

  enum Discipline {
    SingleRope
    DoubleDutch
    Wheel
  }

  enum TrickType {
    basic
    manipulation
    multiple
    power
    release
    impossible
  }

  enum Currency {
    eur
    usd
    sek
  }

  type Query {
    me: User
    """Exact match on email, username or user id. Super admins only."""
    findUsers (query: String!): [User!]!
    """Every user that holds at least one grant. Super admins only."""
    usersWithGrants: [User!]!

    trick (id: ID!): Trick
    trickBySlug (discipline: Discipline!, slug: String!): Trick
    tricks (
      discipline: Discipline,
      searchQuery: String
    ): [Trick!]!

    products: [Product!]!
    shippingRates: [Price!]!

    eventDefinitions: [EventDefinition!]! @cacheControl(maxAge: 3600)

    rulesets: [Ruleset!]! @cacheControl(maxAge: 3600)

    languages: [Language!]! @cacheControl(maxAge: 3600)
  }

  type Mutation {
    # Tricks
    createTrick (data: CreateTrickInput!): Trick!
    updateTrickDetails (trickId: ID!, data: UpdateTrickDetailsInput!): Trick!
    setTrickLocalisation (trickId: ID!, lang: String!, data: TrickLocalisationInput!): TrickLocalisation!
    addTrickPrerequisite (trickId: ID!, prerequisiteId: ID!): Trick!
    removeTrickPrerequisite (trickId: ID!, prerequisiteId: ID!): Trick!

    # Checklist
    createTrickCompletion (trickId: ID!): TrickCompletion!
    deleteTrickCompletion (trickId: ID!): TrickCompletion

    # Speed
    createSpeedResult (data: SpeedResultInput!): SpeedResult!
    updateSpeedResult (speedResultId: ID!, data: SpeedResultUpdateInput!): SpeedResult!
    deleteSpeedResult (speedResultId: ID!): SpeedResult!

    # Shop
    createCheckoutSession (products: [ProductInput!]!, currency: Currency!): CheckoutSession!

    # Rulesets
    createRuleset (rulesId: ID!, names: [LocalisedStringInput!]!): Ruleset!
    updateRuleset (rulesId: ID!, names: [LocalisedStringInput!]!): Ruleset!
    setPrimaryRuleset (rulesId: ID!): Ruleset!

    # Trick levels
    """Sets the level of a trick under a ruleset. A null or empty level deletes it."""
    setTrickLevel (trickId: ID!, rulesId: ID!, level: String): TrickLevel
    """Verifies the level at the given verification level, or recalls the verification when null."""
    setTrickLevelVerification (trickId: ID!, rulesId: ID!, verificationLevel: VerificationLevel): TrickLevel!

    # Trick videos
    addTrickVideo (trickId: ID!, data: YouTubeVideoInput!): Trick!
    """
    Starts a direct upload to Mux. Upload the file to the returned \`url\`, the
    video is added to the trick once Mux has processed it.
    """
    createTrickVideoUpload (trickId: ID!, data: VideoUploadInput!): TrickVideoUpload!
    removeTrickVideo (trickId: ID!, videoId: String!): Trick!

    # Languages
    createLanguage (lang: String!): Language!
    setLanguageEnabled (lang: String!, enabled: Boolean!): Language!

    # Users
    setUserGrants (userId: ID!, grants: [GrantInput!]!): User!
  }

  type Trick @cacheControl(maxAge: 3600) {
    id: ID!
    slug: String!
    discipline: Discipline!
    trickType: TrickType!

    # defaults to english
    localisation (lang: String): TrickLocalisation

    videos: [Video!]!
    """
    The video uploads of this trick that haven't finished processing yet.
    Empty for users who may not edit trick videos.
    """
    pendingVideoUploads: [TrickVideoUpload!]! @cacheControl(maxAge: 0, scope: PRIVATE)
    levels (rulesId: String): [TrickLevel!]!

    prerequisites: [Trick!]!
    prerequisiteFor: [Trick!]!

    submitter: User

    createdAt: Timestamp
    updatedAt: Timestamp
  }

  type TrickLocalisation @cacheControl(maxAge: 3600) {
    id: ID!
    name: String!
    alternativeNames: [String!]
    description: String

    createdAt: Timestamp
    updatedAt: Timestamp
    submitter: User
  }

  input CreateTrickInput {
    discipline: Discipline!
    trickType: TrickType!
    slug: String!
    """The english localisation of the new trick"""
    localisation: TrickLocalisationInput!
  }

  input UpdateTrickDetailsInput {
    discipline: Discipline
    trickType: TrickType
    slug: String
  }

  input TrickLocalisationInput {
    name: String!
    alternativeNames: [String!]!
    description: String!
  }

  type Ruleset @cacheControl(maxAge: 3600) {
    id: ID!
    """Display name in \`lang\`, falling back to english"""
    name (lang: String): String!
    names: [LocalisedString!]!
    isPrimary: Boolean!
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  type Language @cacheControl(maxAge: 3600) {
    id: ID!
    """Whether the public site offers the language"""
    enabled: Boolean!
  }

  type LocalisedString {
    lang: String!
    value: String!
  }

  input LocalisedStringInput {
    lang: String!
    value: String!
  }

  type TrickLevel @cacheControl(maxAge: 3600) {
    id: ID!
    trick: Trick!
    rulesId: String!
    ruleset: Ruleset!
    level: String!
    verificationLevel: VerificationLevel
    verifiedAt: Timestamp
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  enum VerificationLevel {
    JUDGE
    OFFICIAL
  }

  type Video {
    host: VideoHost!
    """
    Host-specific identifier for the video.
    For YouTube this is the video ID, for Mux this is the public playback ID.
    """
    videoId: String!
    type: VideoType!
    slowMoStart: Float
  }

  enum VideoHost {
    YouTube
    Mux
  }

  enum VideoType {
    SlowMo
    Explainer
  }

  input YouTubeVideoInput {
    videoId: String!
    type: VideoType!
    slowMoStart: Float
  }

  input VideoUploadInput {
    type: VideoType!
    slowMoStart: Float
  }

  enum VideoUploadStatus {
    Waiting
    Processing
    Ready
    Errored
    Cancelled
  }

  """A direct upload of a trick video to Mux"""
  type TrickVideoUpload {
    """The Mux upload ID"""
    id: ID!
    """
    Upload the file with a single PUT to this URL. Mux only hands it out once,
    so it's only set on the \`createTrickVideoUpload\` response and null
    everywhere else.
    """
    url: String
    type: VideoType!
    slowMoStart: Float
    status: VideoUploadStatus!
    """Why the upload failed, only set when the status is \`Errored\`"""
    error: String
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  type User {
    id: ID!
    username: String
    name: String
    lang: String
    photo: String
    """Only visible to the user themselves and to super admins"""
    email: String @cacheControl(maxAge: 0, scope: PRIVATE)

    profile: ProfileOptions!

    # groups: [Group!]! # Only top-level groups?
    # friends: [User!]! # maybe in the future?

    checklist: [TrickCompletion!]!
    speedResults (limit: Int, startAfter: Timestamp): [SpeedResult!]!
    speedResult (speedResultId: ID!): SpeedResult

    # store fcm tokens in db? don't expose if so

    """Only visible to the user themselves and to super admins, empty for everyone else"""
    grants: [Grant!]! @cacheControl(maxAge: 0, scope: PRIVATE)
  }

  enum GrantType {
    SuperAdmin
    TrickEditor
    Translator
    LevelEditor
  }

  type Grant {
    type: GrantType!
    """Translator only"""
    lang: String
    """LevelEditor only"""
    rulesId: String
    """LevelEditor only, null means the user may edit but not verify"""
    verificationLevel: VerificationLevel
  }

  input GrantInput {
    type: GrantType!
    """Translator only"""
    lang: String
    """LevelEditor only"""
    rulesId: String
    """LevelEditor only"""
    verificationLevel: VerificationLevel
  }

  type ProfileOptions {
    public: Boolean!
    checklist: Boolean!
    speed: Boolean!
  }

  type TrickCompletion {
    id: ID!
    trick: Trick!
    createdAt: Timestamp!
  }

  union SpeedResult = SimpleSpeedResult | DetailedSpeedResult

  type SimpleSpeedResult {
    id: ID!
    name: String
    creator: User!
    createdAt: Timestamp!

    count: Int!
    eventDefinition: EventDefinition!
  }

  type DetailedSpeedResult {
    id: ID!
    name: String
    creator: User!
    createdAt: Timestamp!

    count: Int!
    eventDefinition: EventDefinition!

    clicks: [Timestamp!]!
    clicksPerSecond: Float!
    maxClicksPerSecond: Float!
    misses: Int!
    jumpsLost: Int!
  }

  input SpeedResultInput {
    name: String
    count: Int!
    clicks: [Timestamp!]

    eventDefinitionId: ID
    eventDefinition: EventDefinitionInput
  }

  input SpeedResultUpdateInput {
    name: String

    eventDefinitionId: ID
    eventDefinition: EventDefinitionInput
  }

  input EventDefinitionInput {
    name: String!
    totalDuration: Int!
  }

  type EventDefinition @cacheControl(maxAge: 3600) {
    id: ID!
    name: String!
    totalDuration: Int!
    eventDefinitionLookupCode: String
  }

  type Product {
    id: ID!
    name: String!
    description: String
    image: String
    prices: [Price!]!
  }

  type Price {
    id: ID!
    currency: Currency!
    unitAmount: Int
  }

  type CheckoutSession {
    id: ID!
    url: String!
  }

  input ProductInput {
    productId: String!
    quantity: Int!
  }
`

export default typeDefs
