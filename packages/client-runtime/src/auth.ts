import { passkeyClient } from "@better-auth/passkey/client"
import { createAuthClient } from "better-auth/client"
import { organizationClient } from "better-auth/client/plugins"

/**
 * Better Auth's browser client.
 *
 * Separate from the RPC socket on purpose: auth is plain HTTP against
 * `/api/auth/*` and it has to work before a socket exists, which is exactly the
 * moment the sign-in screen needs it.
 *
 * Passkeys are offered only where they can actually work. WebAuthn requires a
 * secure context and browsers exempt `localhost` and nothing else, so a phone
 * hitting `http://studio.local:3000` gets no credential API at all -- the
 * button would be dead on the one surface it was recommended for. `local` and
 * `tunnel` get passkeys; `lan` gets a password.
 */

export type EvieAuthClient = ReturnType<typeof createEvieAuthClient>

export function createEvieAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    plugins: [organizationClient(), passkeyClient()],
  })
}

/**
 * Redeems the one-time token the launcher put in the URL.
 *
 * Local mode does not hand a cookie to the first loopback caller: every other
 * process on the box can reach 127.0.0.1, and so can a page in the browser the
 * user happens to have open. What sits behind that cookie is an agent with a
 * shell in the user's home directory, so it is the highest-value cookie on the
 * machine. A single-use token in the URL the launcher itself opened closes the
 * race, and it is the pattern Jupyter and VS Code tunnels settled on for the
 * same reason.
 *
 * The token is stripped from the address bar on success so a reload does not
 * replay a spent token and land the user on an error.
 */
export async function redeemClaim(baseURL: string): Promise<boolean> {
  const url = new URL(globalThis.location.href)
  const token = url.searchParams.get("claim")
  if (!token) return false

  // Better Auth mounts a plugin endpoint at the auth base path, so the
  // `evie-claim` plugin's `/claim` route is `/api/auth/claim` -- not
  // `/api/auth/evie/claim`. The plugin id names the plugin, not the path.
  const response = await fetch(`${baseURL}/api/auth/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  })

  url.searchParams.delete("claim")
  globalThis.history.replaceState(null, "", url.toString())

  return response.ok
}
