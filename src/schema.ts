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

  enum GroupRole {
    """May manage the group, the people in it and the scores shared with it"""
    Admin
    Member
  }

  enum GroupInviteStatus {
    Pending
    Accepted
    Declined
  }

  enum GroupInviteKind {
    """An admin asked this person to join"""
    Invited
    """This person redeemed the join code and is waiting to be let in"""
    Requested
  }

  enum TrickSubmissionStatus {
    Pending
    Accepted
    Rejected
  }

  enum Theme {
    Light
    Dark
  }

  type Query {
    me: User
    """
    A user by username or id, the id wins should both match. Null when there
    is no such user, and when their profile isn't public unless they are you.
    """
    user (usernameOrId: ID!): User
    """Exact match on email, username or user id. Super admins only."""
    findUsers (query: String!): [User!]!
    """Every user that holds at least one grant. Super admins only."""
    usersWithGrants: [User!]!

    """Null when there is no such group, and when you are not in it"""
    group (groupId: ID!): Group
    """Null when there is no such member, and when you are not in their group"""
    groupMember (memberId: ID!): GroupMember
    """Only \`id\` and \`name\` resolve for somebody outside the group"""
    groupByJoinCode (joinCode: String!): Group

    trick (id: ID!): Trick
    trickBySlug (discipline: Discipline!, slug: String!): Trick
    tricks (
      discipline: Discipline,
      searchQuery: String,
      filter: TrickFilter
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

    """Trick submissions, newest first, in every status unless one is given. Trick editors only."""
    trickSubmissions (status: TrickSubmissionStatus): [TrickSubmission!]!

    """The notices live right now, scheduled ones only inside their window"""
    notices: [Notice!]! @cacheControl(maxAge: 60)
    """Every notice, live or not. Super admins only."""
    allNotices: [Notice!]! @cacheControl(maxAge: 0, scope: PRIVATE)
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
    """Share a score with a group and say who competed, see SpeedResultGroupInput"""
    setSpeedResultGroup (speedResultId: ID!, data: SpeedResultGroupInput!): SpeedResult!
    """
    Leaves the score out of the bests of everyone who competed in it, or puts
    it back. Whoever may edit the score may set this.
    """
    excludeSpeedResultFromPersonalBests (speedResultId: ID!, excluded: Boolean!): SpeedResult!
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
    """
    Sets who a video is credited to, a null attribution removes the credit.
    Editing a credit keeps the original contribution date.
    """
    setTrickVideoAttribution (trickId: ID!, videoId: String!, attribution: AttributionInput): Trick!

    # Trick submissions
    """Starts a trick submission. Upload the video file with a single PUT to \`upload.url\`."""
    createTrickSubmission (data: TrickSubmissionInput!): TrickSubmission!
    """Creates the trick from the submission and credits the submitter on its video and localisation"""
    acceptTrickSubmission (submissionId: ID!, data: AcceptTrickSubmissionInput!): TrickSubmission!
    rejectTrickSubmission (submissionId: ID!, note: String): TrickSubmission!

    # Languages
    createLanguage (lang: String!): Language!
    setLanguageEnabled (lang: String!, enabled: Boolean!): Language!

    # Interface messages
    """
    Sets interface messages of a language, keys that aren't included are left
    alone. English is the site's source language and cannot be set here.
    """
    setUiMessages (lang: String!, entries: [UiMessageInput!]!): [UiMessageEntry!]!

    # Notices
    createNotice (data: NoticeInput!): Notice!
    updateNotice (noticeId: ID!, data: NoticeInput!): Notice!
    deleteNotice (noticeId: ID!): Notice!

    # Groups
    createGroup (name: String!): Group!
    updateGroup (groupId: ID!, name: String!): Group!
    """Refused while any speed score is shared with the group"""
    deleteGroup (groupId: ID!): Group!

    """Adds an athlete the group manages, who has no account of their own"""
    addGroupAthlete (groupId: ID!, name: String!): GroupMember!
    """The member as it should be once the update is applied"""
    updateGroupMember (memberId: ID!, data: GroupMemberInput!): GroupMember!
    """One who has competed in a score the group holds is kept as an athlete it manages"""
    removeGroupMember (memberId: ID!): GroupMember!
    leaveGroup (groupId: ID!): Group!

    """
    Invites a user, found by username or id whether or not their profile is
    public. Pass a \`memberId\` to hand over an athlete the group manages.
    """
    inviteToGroup (groupId: ID!, usernameOrId: ID!, role: GroupRole!, observer: Boolean!, memberId: ID): GroupInvite!
    cancelGroupInvite (inviteId: ID!): GroupInvite!
    """The invited user accepts or declines"""
    respondToGroupInvite (inviteId: ID!, accept: Boolean!): GroupInvite!

    """Generates a join code, replacing and invalidating any previous one"""
    setGroupJoinCode (groupId: ID!): Group!
    clearGroupJoinCode (groupId: ID!): Group!
    """Asks to join the group a code belongs to. An admin still has to approve."""
    requestToJoinGroup (joinCode: String!): GroupInvite!
    """Pass a \`memberId\` to hand the newcomer an athlete the group manages"""
    respondToGroupJoinRequest (inviteId: ID!, accept: Boolean!, memberId: ID): GroupInvite!

    """
    Ticks or unticks a trick for a member of a group, admins only. Null when the
    trick was unticked.
    """
    setGroupMemberTrickCompletion (memberId: ID!, trickId: ID!, completed: Boolean!): TrickCompletion

    # Users
    """The signed in user's language, null clears it"""
    setUserLang (lang: String): User!
    """The signed in user's colour theme, null follows the system"""
    setUserTheme (theme: Theme): User!
    """The signed in user's name and username, both are set on every update"""
    updateUserProfile (data: UserProfileInput!): User!
    """What others get to see of the signed in user's profile"""
    setProfileOptions (data: ProfileOptionsInput!): User!
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
    """Everyone credited on the trick's videos and localisations, earliest contribution first"""
    contributors: [Contributor!]!

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
    attribution: Contributor
  }

  """Who contributed to a trick, credited by the name they chose"""
  type Contributor @cacheControl(inheritMaxAge: true) {
    userId: ID
    name: String!
    contributedAt: Timestamp!
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

  input TrickLevelFilter {
    rulesId: ID!
    """Also match levels verified below this, absent matches missing levels only"""
    verifiedBelow: VerificationLevel
  }

  input TrickFilter {
    """Tricks with no localisation in this language, or one whose name or description is empty"""
    missingLocalisation: String
    """Tricks whose level in a ruleset is missing, or verified below a level"""
    level: TrickLevelFilter
    withoutVideos: Boolean
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
    """
    The English message this was translated from, which differs from the site's
    current English when the translation needs redoing. Null for translations
    saved before we recorded it.
    """
    source: String
    """Null when the user who set the message no longer exists"""
    updatedBy: User
    updatedAt: Timestamp!
  }

  input UiMessageInput {
    key: String!
    """empty or null removes the key"""
    value: String
    """The English message this is a translation of, as the site words it today"""
    source: String
  }

  type LocalisedString {
    lang: String!
    value: String!
  }

  """A message shown on the public site's home page"""
  type Notice @cacheControl(maxAge: 60) {
    id: ID!
    """Shown from this moment, straight away when absent"""
    from: Timestamp
    """Shown until this moment, indefinitely when absent"""
    until: Timestamp
    """
    The text in this language, falling back to the language's primary subtag
    and then to English, which every notice has
    """
    text (lang: String): NoticeText!
    """Every language the notice has a text in"""
    texts: [NoticeText!]!
    createdAt: Timestamp!
    updatedAt: Timestamp!
    """Null when the user who last saved the notice no longer exists"""
    updatedBy: User
  }

  type NoticeText @cacheControl(maxAge: 60) {
    lang: String!
    body: String!
    links: [NoticeLink!]!
  }

  type NoticeLink @cacheControl(maxAge: 60) {
    label: String!
    """An absolute http(s) URL, a mailto: address, or a path on the public site starting with /"""
    url: String!
  }

  input NoticeInput {
    from: Timestamp
    until: Timestamp
    """The link targets; each language's text carries one label per URL, in this order"""
    linkUrls: [String!]!
    """Must include English. A language listed here needs a body and every link label."""
    texts: [NoticeTextInput!]!
  }

  input NoticeTextInput {
    lang: String!
    body: String!
    """One label per entry of linkUrls, in the same order"""
    linkLabels: [String!]!
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
    attribution: Contributor
  }

  enum VideoHost {
    YouTube
    Mux
  }

  enum VideoType {
    """An edited clip, the trick at full speed followed by the same run slowed down"""
    SlowMo
    """One run of the trick at natural speed, the player makes the slow motion"""
    FullSpeed
    Explainer
  }

  """
  Who to credit a video to, by the name they want shown. The username or id
  is optional and links the credit to an existing account.
  """
  input AttributionInput {
    name: String!
    usernameOrId: ID
  }

  input YouTubeVideoInput {
    videoId: String!
    type: VideoType!
    slowMoStart: Float
    attribution: AttributionInput
  }

  input VideoUploadInput {
    type: VideoType!
    slowMoStart: Float
    attribution: AttributionInput
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
    """Who the video will be credited to once it is ready"""
    attribution: Contributor
    status: VideoUploadStatus!
    """Why the upload failed, only set when the status is \`Errored\`"""
    error: String
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  """A trick a user has offered, waiting for a trick editor to review it"""
  type TrickSubmission @cacheControl(maxAge: 0, scope: PRIVATE) {
    id: ID!
    submitter: User!
    attributionName: String!
    discipline: Discipline!
    trickType: TrickType
    lang: String!
    name: String!
    alternativeNames: [String!]
    description: String
    status: TrickSubmissionStatus!
    """The video upload, its \`url\` is only set on the \`createTrickSubmission\` response"""
    upload: TrickVideoUpload!
    """The video Mux made of the uploaded file, null until it has finished processing"""
    video: Video
    reviewNote: String
    reviewedAt: Timestamp
    """The trick this became, only set once the submission was accepted"""
    trick: Trick
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  input TrickSubmissionInput {
    discipline: Discipline!
    trickType: TrickType
    """Language of the text fields, defaults to the user's language, then English"""
    lang: String
    name: String!
    alternativeNames: [String!]
    description: String
    """The name to credit the submitter by, copied as it is given"""
    attributionName: String!
    """Must be true: the submitter grants a CC BY 4.0 licence to the submission"""
    acceptLicence: Boolean!
  }

  input AcceptTrickSubmissionInput {
    discipline: Discipline!
    trickType: TrickType!
    slug: String!
    """The english localisation of the new trick"""
    localisation: TrickLocalisationInput!
    videoType: VideoType!
    slowMoStart: Float
  }

  type User {
    id: ID!
    username: String
    name: String
    lang: String
    """Null follows the system"""
    theme: Theme
    photo: String
    """Only visible to the user themselves and to super admins"""
    email: String @cacheControl(maxAge: 0, scope: PRIVATE)

    profile: ProfileOptions!

    """The groups the user is in. Only visible to the user themselves."""
    groups: [Group!]! @cacheControl(maxAge: 0, scope: PRIVATE)
    """
    Invitations waiting for the user's answer, and join requests they have made,
    newest first. Only the \`Invited\` ones need an answer from them. Only visible
    to the user themselves.
    """
    groupInvites: [GroupInvite!]! @cacheControl(maxAge: 0, scope: PRIVATE)

    # friends: [User!]! # maybe in the future?

    """Visible to the user themselves, and to everyone on a public profile that shows its checklist"""
    checklist: [TrickCompletion!]!
    """
    How many tricks the user has completed, in total and per Tricktionary
    level. Visible to the user themselves and to everyone on a public profile.
    """
    checklistStats: ChecklistStats!
    """
    The scores the user competed in, and the ones they entered and have not
    yet said who competed in, newest first. Every filter is optional and they
    combine. Only visible to the user themselves.
    """
    speedResults (
      limit: Int
      startAfter: Timestamp
      """Only the scores in this event"""
      eventDefinitionId: ID
      """Only the scores shared with this group"""
      groupId: ID
    ): [SpeedResult!]!
    speedResult (speedResultId: ID!): SpeedResult
    """
    The user's best in each predefined event they have a score in, in the
    order the events are listed. Every score they competed in counts, however
    it was entered and whoever counted it, and custom events are left out.
    Visible to the user themselves, and to everyone on a public profile that
    shows its speed scores.
    """
    speedBests: [SpeedPersonalBest!]!

    # store fcm tokens in db? don't expose if so

    """Only visible to the user themselves and to super admins, empty for everyone else"""
    grants: [Grant!]! @cacheControl(maxAge: 0, scope: PRIVATE)

    """The tricks the user has submitted, newest first. Only the user themselves and trick editors may read it."""
    trickSubmissions: [TrickSubmission!]! @cacheControl(maxAge: 0, scope: PRIVATE)
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
    """Whether anyone may see the profile: name, photo, username and checklist stats"""
    public: Boolean!
    """Whether the completed tricks are shown on the public profile"""
    checklist: Boolean!
    """Whether the speed personal bests are shown on the public profile"""
    speed: Boolean!
  }

  input ProfileOptionsInput {
    public: Boolean!
    """Stored as false while the profile isn't public"""
    checklist: Boolean!
    """Stored as false while the profile isn't public"""
    speed: Boolean!
  }

  input UserProfileInput {
    """Shown on the profile and next to contributions"""
    name: String!
    """
    The handle the profile is reachable at, as /profile/<username>. 3 to 30
    lowercase letters, digits, dots, dashes or underscores, starting and
    ending with a letter or digit; uppercase is lowercased on save. Null or
    omitted releases the current username, an empty string is rejected.
    """
    username: String
  }

  """A coach and their athletes"""
  type Group @cacheControl(maxAge: 0, scope: PRIVATE) {
    id: ID!
    name: String!
    """Everybody in the group, athletes and observers alike"""
    members: [GroupMember!]!
    """The caller's own membership, null when they are not in the group"""
    myMembership: GroupMember
    """Invitations sent and requests waiting, newest first. Admins only, empty for everyone else."""
    invites: [GroupInvite!]!
    """The active join code. Admins only, and null for everyone else and when there is none."""
    joinCode: String
    """The scores shared with the group, newest first. Every filter is optional and they combine."""
    speedResults (
      limit: Int
      startAfter: Timestamp
      eventDefinitionId: ID
      """
      Exactly this set of athletes, in any order, not a superset. An empty
      list finds the scores nobody has been assigned to yet.
      """
      constellation: [ID!]
    ): [SpeedResult!]!
    """The sets of athletes that appear on the group's scores, commonest first"""
    constellations: [GroupConstellation!]!
    createdAt: Timestamp!
    updatedAt: Timestamp!
  }

  """A set of athletes that competed together in the group's scores"""
  type GroupConstellation {
    """Stable identifier of the set, pass it back as \`constellation\`"""
    key: String!
    members: [GroupMember!]!
    resultCount: Int!
  }

  """
  One without a \`user\` is an athlete the group manages. An invite hands such a
  row over, and what was recorded against it becomes that user's own.
  """
  type GroupMember @cacheControl(maxAge: 0, scope: PRIVATE) {
    id: ID!
    group: Group!
    """Null for an athlete the group manages who has no account yet"""
    user: User
    """Their own name, else the one the group gave them, else their username"""
    name: String!
    role: GroupRole!
    """Left out of the group's checklist and speed scores"""
    observer: Boolean!
    """
    The athlete's completed tricks. Their own once they have an account, else
    the group's record of them, which becomes theirs when they claim the row.
    """
    checklist: [TrickCompletion!]!
    checklistStats: ChecklistStats!
    """
    This athlete's best in each predefined event they have a score in. An
    athlete with an account gets their own bests, across every group they are
    in and their unshared scores alike; one the group manages gets the bests
    among the scores that name them.
    """
    speedBests: [SpeedPersonalBest!]!
    """
    This athlete's scores in one event, newest first, whether they competed
    the whole event or a single leg of it. A leg reports the count and pace of
    that leg, so the same athlete's showing can be followed across
    constellations.
    """
    speedProgression (eventDefinitionId: ID!): [SpeedSegmentResult!]!
    createdAt: Timestamp!
  }

  type SpeedSegmentResult {
    result: SpeedResult!
    """Null when the athlete competed the whole event rather than one leg"""
    segment: SpeedSegment
    """The athlete's own steps: the leg's when they competed a leg, else the result's"""
    count: Int!
    """Null for a result entered as a plain count"""
    stepsPerSecond: Float
  }

  """An athlete's best in one event"""
  type SpeedPersonalBest {
    eventDefinition: EventDefinition!
    """The highest total the athlete was part of, whether they jumped the whole event or one leg of it"""
    total: SpeedResult!
    """
    The athlete's best own leg, by its count. Null when the athlete never jumped
    a leg of this event, since their own showing is then the total.
    """
    ownSegment: SpeedSegmentResult
  }

  """An invitation from a group, or a request to join one, told apart by \`kind\`"""
  type GroupInvite @cacheControl(maxAge: 0, scope: PRIVATE) {
    id: ID!
    group: Group!
    user: User!
    kind: GroupInviteKind!
    role: GroupRole!
    observer: Boolean!
    """The athlete the group manages that this hands over, and once accepted, the row the user holds"""
    member: GroupMember
    """The admin who invited. Null on a request, and when they no longer exist."""
    invitedBy: User
    status: GroupInviteStatus!
    """Answering is refused once this passes, and the invitation is deleted soon after"""
    expiresAt: Timestamp!
    createdAt: Timestamp!
  }

  input GroupMemberInput {
    """Required for an athlete the group manages, rejected for a member with an account"""
    name: String
    role: GroupRole!
    observer: Boolean!
  }

  type ChecklistStats {
    """Completed tricks, including ones without a Tricktionary level"""
    completed: Int!
    """One entry per Tricktionary level that has tricks, lowest first"""
    levels: [ChecklistLevelStats!]!
  }

  type ChecklistLevelStats {
    level: String!
    completed: Int!
    total: Int!
  }

  type TrickCompletion {
    id: ID!
    trick: Trick!
    """The group admin who ticked this off, null when the athlete did it themselves"""
    recordedBy: User
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
    null when the event had none. When its audio was played the offsets are
    into the audio and the result's 'start' mark is the moment it started
    playing, otherwise the audio is gone and the cues are measured from the
    go signal.
    """
    timingTrack: TimingTrack
    """Derived from the marks, null for results without any step marks"""
    analysis: SpeedAnalysis
    """
    The event split leg by leg: derived from the marks when the score was
    counted, laid out from \`segmentCounts\` when it was entered as a plain
    count, and empty when the score says nothing about how the event splits.
    """
    segments: [SpeedSegment!]!
    """
    The steps of each leg as they were entered on a plain count, null when
    none were, see \`segments\` for the legs they describe
    """
    segmentCounts: [Int!]
    """
    Whether this score was counted step by step rather than entered as a
    total, so a list can tell the two apart without asking for the marks or
    the analysis. True exactly when there is an analysis to show.
    """
    counted: Boolean!
    """
    Whether the score is left out of the bests of everyone who competed in it.
    It still shows in the lists and carries its analysis either way, only the
    bests skip it.
    """
    excludedFromPersonalBests: Boolean!

    """Null for a score that is yours alone"""
    group: Group
    """Who competed, empty while nobody has been assigned"""
    participants: [SpeedParticipant!]!
  }

  type SpeedParticipant {
    """The segment of the analysis they competed, null when they competed the whole score"""
    segmentIndex: Int
    member: GroupMember!
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
    The pace in each whole second of the event, index 0 is the first second
    after the start. Handy for plotting the whole duration.

    This is the time-weighted average of the rates between steps, not a count
    of the steps landing in the second, so a steady rhythm reads as a steady
    rate rather than alternating between neighbouring whole numbers.
    """
    stepsPerSecondSeries: [Float!]!
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
    """
    The steps of each leg of a relay, one per segment of the event and adding
    up to \`count\`. Only for a score entered as a plain count, the legs of a
    counted score come from its marks.
    """
    segmentCounts: [Int!]
    """Rulesets-compatible mark stream, see SpeedResult.marks"""
    marks: [SpeedMarkInput!]
    """
    Whether the event definition's audio was played while counting, in which
    case the marks should contain a 'start' mark for the moment it started. A
    known event's cues are stored with the result either way, see
    SpeedResult.timingTrack.
    """
    withTimingTrack: Boolean

    eventDefinitionId: ID
    eventDefinition: EventDefinitionInput

    """Share the score with a group you are in, see SpeedResult.group"""
    groupId: ID
    """Requires a groupId, see SpeedResult.participants"""
    participants: [SpeedParticipantInput!]
  }

  input SpeedResultUpdateInput {
    """Omit to keep the current name, pass null or an empty string to clear it"""
    name: String
    """Only allowed for results that were entered as a plain count"""
    count: Int
    """
    The steps of each leg, one per segment of the event and adding up to
    \`count\`. One record with \`count\`: whenever a count is given this states
    the legs in full, and leaving it out leaves the score with no legs. It is
    never "omit to keep", so changing the event of a score that has legs means
    giving the count and the legs again.
    """
    segmentCounts: [Int!]

    eventDefinitionId: ID
    eventDefinition: EventDefinitionInput
  }

  """Both fields state the whole record after the call, neither is a partial edit"""
  input SpeedResultGroupInput {
    """The group the score belongs to, null for none, which also clears who competed"""
    groupId: ID
    """Everyone who competed, replacing whoever was named before"""
    participants: [SpeedParticipantInput!]!
  }

  input SpeedParticipantInput {
    segmentIndex: Int
    memberId: ID!
  }

  input EventDefinitionInput {
    name: String!
    totalDuration: Int!
    """
    Athlete switches in a custom relay, so its steps can be attributed to
    each athlete without an official timing track. The clock runs from zero
    to totalDuration, so there is no End cue, and a Start cue is only
    accepted at offset 0, where it names the opening stretch. Switches must
    fall inside the event.
    """
    cues: [TimingCueInput!]
  }

  type EventDefinition @cacheControl(maxAge: 3600) {
    id: ID!
    name: String!
    """Duration of the event in seconds, 0 for events without a time limit"""
    totalDuration: Int!
    """The rulesets competition event lookup code (without version) when this is a known competition event"""
    eventDefinitionLookupCode: String
    """The moments that matter in the event, with its audio when one has been uploaded"""
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
    """Milliseconds from the start of the audio, or from the go signal when the track has no audio"""
    offset: Int!
    """e.g. the name of the athlete position that starts here"""
    label: String
  }

  """The moments that matter in an event, and the audio to play them, if any"""
  type TimingTrack {
    """Publicly readable URL of the audio file, null for cues without audio"""
    audioUrl: String
    cues: [TimingCue!]!
  }

  input TimingCueInput {
    type: TimingCueType!
    offset: Int!
    label: String
  }

  input TimingTrackInput {
    """
    The audioUrl returned by createTimingTrackUpload. Omit it for an event
    whose cues are known but which has no audio to play: the offsets are then
    measured from the go signal, so there is no End cue, and a Start cue is
    only accepted at offset 0, where it names the opening stretch.
    """
    audioUrl: String
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
    """
    Null removes the track, and its audio file. Switch cues must fall inside
    the event, which then needs a total duration.
    """
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
