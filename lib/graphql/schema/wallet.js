import { gql } from 'apollo-server-express'

export default gql`
  extend type Query {
    wallets: [Wallet!]!
    wallet(id: ID!): Wallet!
    addresses(id: ID!): [String!]!
  }

  extend type Mutation {
    createWallet(password: String!): Wallet!
    createAddress(id: ID!, password: String!): String!
  }

  type Wallet {
    "A random ID given by randomId() from CryptoUtil"
    id: ID! 
    "The hash result of the user informed password"
    passwordHash: String!
    """
    Salty randomness from CryptoEdDSAUtil.
    This is used for brand new wallets as a salt for
    generating the key pairs. After the first keyPair,
    the last available secretKey is used as a salt.
    """
    secret: String
    """
    Private and Public keys of this wallet.
    This is here for educational purposes (i.e wallet structure).
    In the real world, private kinda means private.
    """
    keyPairs: [KeyPair!]!
    """
    The public keys of the wallet's key pairs.
    This would actually be used in the wallet's schema.
    """
    addresses: [String!]!
  }
`