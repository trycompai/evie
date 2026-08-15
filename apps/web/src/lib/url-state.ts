import { parseAsArrayOf, parseAsString } from "nuqs"

/**
 * Query state.
 *
 * Where you are is the path -- the router owns that. What is left for the query
 * string is state that *refines* a place rather than names one, which is the
 * split T3 Code draws and the one that keeps a conversation link readable.
 *
 * There is one such thing today. Parsers live here rather than inline so a
 * future link-builder agrees with the screen by construction.
 */

/**
 * Services picked during onboarding.
 *
 * In the URL because refreshing halfway through setup should not silently
 * unpick everything. Clears itself when empty, so the common case leaves no
 * trace in the address bar.
 */
export const connectedAppsParser = parseAsArrayOf(parseAsString).withDefault([])
