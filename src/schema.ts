import { gql } from 'graphql-tag'

const typeDefs = gql`
  directive @cacheControl(
    maxAge: Int
    scope: CacheControlScope
    inheritMaxAge: Boolean
  ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION

  scalar Timestamp
  scalar JSONObject

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

    """
    The public site's interface messages in a language as a flat map keyed like
    its en.json (\`{ "trick.level": "..." }\`). Empty for a language nobody has
    translated yet.
    """
    uiMessages (lang: String!): JSONObject! @cacheControl(maxAge: 3600)
    """Every translated interface message of a language, with who last set it"""
    uiMessageEntries (lang: String!): [UiMessageEntry!]! @cacheControl(maxAge: 0, scope: PRIVATE)
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

    # Event definitions (speed editors)
    createEventDefinition (data: EventDefinitionCreateInput!): EventDefinition!
    """Omitted fields are left alone, a null timingTrack removes the track"""
    updateEventDefinition (eventDefinitionId: ID!, data: EventDefinitionUpdateInput!): EventDefinition!
    """Refused while any speed result refers to the event"""
    deleteEventDefinition (eventDefinitionId: ID!): EventDefinition!
    """
    Starts an upload of a timing track audio file. PUT the file, with the same
    Content-Type, to the returned \`url\` and then save the returned
    \`audioUrl\` on the event definition with updateEventDefinition.
    """
    createTimingTrackUpload (eventDefinitionId: ID!, contentType: String!): TimingTrackUpload!

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

    # Interface messages
    """
    Sets interface messages of a language, keys that aren't included are left
    alone. English is the site's source language and cannot be set here.
    """
    setUiMessages (lang: String!, entries: [UiMessageInput!]!): [UiMessageEntry!]!

    # Users
    """The signed in user's language, null clears it"""
    setUserLang (lang: String): User!
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

  type UiMessageEntry {
    """The dotted key of the message, e.g. \`trick.level\`"""
    key: String!
    value: String!
    """Null when the user who set the message no longer exists"""
    updatedBy: User
    updatedAt: Timestamp!
  }

  input UiMessageInput {
    key: String!
    """empty or null removes the key"""
    value: String
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
    """Newest first. eventDefinitionId narrows the list to one event."""
    speedResults (limit: Int, startAfter: Timestamp, eventDefinitionId: ID): [SpeedResult!]!
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
    """May manage speed event definitions and their timing tracks"""
    SpeedEditor
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

  """
  A recorded speed score. Results entered as a plain count have an empty mark
  stream and no analysis, results recorded live carry the marks they were
  counted from and an analysis derived from those marks.
  """
  type SpeedResult {
    id: ID!
    name: String
    creator: User!
    createdAt: Timestamp!

    """The number of steps counted, derived from the marks when there are any"""
    count: Int!
    eventDefinition: EventDefinition!

    """
    The mark stream this result was counted from, in the same format as
    @ropescore/rulesets uses so it can be fed straight into its mark reducers.
    Each step is a mark with schema 'step' (value defaults to 1), an optional
    mark with schema 'start' pins the start of the event, 'undo' and
    'clear' marks behave as in the rulesets library. Empty for results
    that were entered as a plain count.
    """
    marks: [SpeedMark!]!
    """
    The event's timing track as it was when the result was recorded with it,
    the result's 'start' mark is the moment the audio started playing
    """
    timingTrack: TimingTrack
    """Derived from the marks, null for results without any step marks"""
    analysis: SpeedAnalysis
  }

  type SpeedMark {
    """Zero-based position in the stream, increments by one per mark"""
    sequence: Int!
    timestamp: Timestamp!
    schema: String!
    """Model dependent, for step marks it is the number of steps the mark is worth (default 1)"""
    value: Float
    """For undo marks: the sequence of the mark being undone"""
    target: Int
  }

  type SpeedAnalysis {
    """
    Seconds the analysis is based on: the event's total duration when it has
    one, otherwise the time between the start (or first step) and the last step
    """
    duration: Float!
    """count / duration"""
    stepsPerSecond: Float!
    """The fastest rate observed between two consecutive step marks"""
    maxStepsPerSecond: Float!
    """
    Number of gaps between steps that were more than 1.5 times longer than the
    average gap, i.e. likely rope catches
    """
    misses: Int!
    """Steps that would have fit in the miss gaps had the athlete kept the average pace"""
    stepsLost: Int!
    """
    Steps counted in each whole second of the event, index 0 is the first
    second after the start. Handy for plotting the whole duration.
    """
    stepsPerSecondSeries: [Int!]!
    """
    The event split at its timing track's switch cues, so a relay's steps can
    be attributed to each athlete. A single segment when there is no track.
    """
    segments: [SpeedSegment!]!
  }

  type SpeedSegment {
    """Zero-based position of the segment in the event"""
    index: Int!
    """The label of the cue that opens the segment, if it has one"""
    label: String
    """Seconds from the start of the event"""
    start: Float!
    end: Float!
    count: Int!
    stepsPerSecond: Float!
  }

  input SpeedMarkInput {
    sequence: Int!
    timestamp: Timestamp!
    schema: String!
    value: Float
    target: Int
  }

  input SpeedResultInput {
    name: String
    """Required when no marks are provided, ignored (derived from the marks) otherwise"""
    count: Int
    """Rulesets-compatible mark stream, see SpeedResult.marks"""
    marks: [SpeedMarkInput!]
    """
    Store the event definition's current timing track with the result. The
    marks should then contain a 'start' mark for the moment the audio started.
    """
    withTimingTrack: Boolean

    eventDefinitionId: ID
    eventDefinition: EventDefinitionInput
  }

  input SpeedResultUpdateInput {
    """Omit to keep the current name, pass null or an empty string to clear it"""
    name: String
    """Only allowed for results that were entered as a plain count"""
    count: Int

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
    """Duration of the event in seconds, 0 for events without a time limit"""
    totalDuration: Int!
    """The rulesets competition event lookup code (without version) when this is a known competition event"""
    eventDefinitionLookupCode: String
    """The official audio track of the event, when one has been uploaded"""
    timingTrack: TimingTrack
  }

  enum TimingCueType {
    """The go signal, the event's clock starts here"""
    Start
    """An athlete switch in a relay"""
    Switch
    """The stop signal"""
    End
  }

  """A moment in a timing track that matters for counting"""
  type TimingCue {
    type: TimingCueType!
    """Milliseconds from the start of the audio"""
    offset: Int!
    """e.g. the name of the athlete position that starts here"""
    label: String
  }

  """The official audio of an event, with the moments that matter in it"""
  type TimingTrack {
    """Publicly readable URL of the audio file"""
    audioUrl: String!
    cues: [TimingCue!]!
  }

  input TimingCueInput {
    type: TimingCueType!
    offset: Int!
    label: String
  }

  input TimingTrackInput {
    """The audioUrl returned by createTimingTrackUpload"""
    audioUrl: String!
    cues: [TimingCueInput!]!
  }

  type TimingTrackUpload {
    """PUT the audio file here with the Content-Type the upload was created with"""
    url: String!
    """Where the file will be readable once uploaded, pass it on to updateEventDefinition"""
    audioUrl: String!
    expiresAt: Timestamp!
  }

  input EventDefinitionCreateInput {
    name: String!
    """Seconds, 0 for events without a time limit"""
    totalDuration: Int!
    """Rulesets competition event lookup code without version, e.g. e.ijru.sp.sr.srss.1.30"""
    lookupCode: String
  }

  input EventDefinitionUpdateInput {
    name: String
    totalDuration: Int
    """Null clears it"""
    lookupCode: String
    """Null removes the track, and its audio file"""
    timingTrack: TimingTrackInput
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
