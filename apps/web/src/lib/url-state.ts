import { parseAsArrayOf, parseAsString, parseAsStringLiteral } from "nuqs"

/**
 * Query state.
 *
 * Where you are is the path -- the router owns that. What is left for the query
 * string is state that *refines* a place rather than names one, which is the
 * split T3 Code draws and the one that keeps a conversation link readable.
 *
 * Parsers live here rather than inline so a future link-builder agrees with
 * the screen by construction.
 */

/**
 * Services picked during onboarding.
 *
 * In the URL because refreshing halfway through setup should not silently
 * unpick everything. Clears itself when empty, so the common case leaves no
 * trace in the address bar.
 */
export const connectedAppsParser = parseAsArrayOf(parseAsString).withDefault([])

/**
 * The Computer pane, one param carrying both facts: absent is closed, and the
 * value is the open tab. Two params would let a link say "closed, on the
 * Terminal tab", which is not a state the screen has. No default on purpose --
 * null IS the closed state, and it keeps a plain conversation link plain.
 */
export const computerTabParser = parseAsStringLiteral(["files", "terminal", "browser"] as const)
