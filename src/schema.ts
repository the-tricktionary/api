import { gql } from 'apollo-server'

const typeDefs = gql`
  scalar Timestamp

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

  type Query {
    me: User
    # findUser (username: String): User

    trick (id: ID!): Trick
    trickBySlug (discipline: Discipline!, slug: String!): Trick
    tricks (
      discipline: Discipline,
      trickType: TrickType,
      # ttLevel: Int,
      # limit: Int,
      # startAt: ID,
    ): [Trick]!

    products: [Product]!
  }

  type Mutation {
    setTrickCompletion (trickId: ID!, completed: Boolean!): TrickCompletion
  }

  type Trick {
    id: ID!
    slug: String!
    discipline: Discipline!
    trickType: TrickType!

    # defaults to english
    localisation (lang: String): TrickLocalisation

    videos: [Video]!
    levels (organisation: String, rulesVersion: String): [TrickLevel]!

    prerequisites: [Trick]!
    prerequisiteFor: [Trick]!

    submitter: User

    createdAt: Timestamp
    updatedAt: Timestamp
  }

  type TrickLocalisation {
    id: ID!
    name: String!
    alternativeNames: [String]
    description: String

    createdAt: Timestamp
    updatedAt: Timestamp
    submitter: User
  }

  type TrickLevel {
    id: ID!
    trick: Trick!
    organisation: String!
    level: String!
    rulesVersion: String
    createdAt: Timestamp!
    updatedAt: Timestamp! # = verified at

    verificationLevel: VerificationLevel
  }

  enum VerificationLevel {
    JUDGE
    OFFICIAL
  }

  type Video {
    host: VideoHost!
    videoId: String!
    type: VideoType!
    slowMoStart: Float
  }

  enum VideoHost {
    YouTube
  }

  enum VideoType {
    SlowMo
    Explainer
  }

  type User {
    id: ID!
    username: String
    name: String
    lang: String
    photo: String

    profile: ProfileOptions!

    # groups: [Group]! # Only top-level groups?
    # friends: [User]! # maybe in the future?

    checklist: [TrickCompletion]!
    # speedResults: [SpeedResult]!
    # getSpeedResult (id: ID!): SpeedResult

    # store fcm tokens in db? don't expose if so

    # TODO: level editor (orgs, vLevel)
    # TODO: trick translator (languages)
    # TODO: trick editor
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

  type Product {
    id: ID!
    name: String!
    description: String
    image: String
    prices: [Price]
  }

  type Price {
    id: ID!
    currency: String!
    unitAmount: Int
  }
`

export default typeDefs
