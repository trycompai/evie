/**
 * Bumped whenever any schema in this package changes shape.
 *
 * `session.hello` carries this from both sides and the server refuses a
 * mismatch with a typed `ContractMismatch`. That is what makes "a client is
 * never newer than its server" enforceable rather than aspirational -- a
 * browser tab on tryevie.ai is easily a version ahead of the environment it
 * dials into, and the alternative is a decode failure twenty frames later.
 */
export const CONTRACT_VERSION = 7
