import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { redeemClaim } from "@evie/client-runtime/auth"
import { App } from "~/app.tsx"
import { createRuntime, resolveBaseURL, RuntimeProvider } from "~/lib/runtime.ts"
import "~/styles.css"

/**
 * Entry.
 *
 * The claim token is redeemed BEFORE the runtime exists, and that ordering is
 * the whole reason this is a top-level await rather than an effect. The socket
 * carries the session cookie on its opening handshake; opening it first would
 * mean connecting unauthenticated, failing, and reconnecting -- a visible
 * flicker through the sign-in screen on every cold start of the desktop app.
 */
await redeemClaim(resolveBaseURL())

const runtime = createRuntime()

const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")

createRoot(root).render(
  <StrictMode>
    <RuntimeProvider value={runtime}>
      <App />
    </RuntimeProvider>
  </StrictMode>,
)
