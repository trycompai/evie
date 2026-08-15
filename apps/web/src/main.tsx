import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RouterProvider } from "@tanstack/react-router"
import { redeemClaim } from "@evie/client-runtime/auth"
import type { ThreadId } from "@evie/contracts/ids"
import { deepLinkStore } from "~/lib/desktop.ts"
import { createRuntime, resolveBaseURL, RuntimeProvider } from "~/lib/runtime.ts"
import { createAppRouter } from "~/router.ts"
import "~/styles.css"

/**
 * Entry.
 *
 * The claim token is redeemed BEFORE the runtime exists, and that ordering is
 * the whole reason this is a top-level await rather than an effect. The socket
 * carries the session cookie on its opening handshake; opening it first would
 * mean connecting unauthenticated, failing, and reconnecting -- a visible
 * flicker through the sign-in screen on every cold start of the desktop app.
 *
 * It also strips `?claim` from the address bar, so it has to finish before the
 * router reads the URL.
 */
await redeemClaim(resolveBaseURL())

const runtime = createRuntime()
const router = createAppRouter(runtime)

/*
 * Deep links never enter React.
 *
 * `evie://thread/<id>` is a request to be somewhere, and where the window is
 * lives in the URL -- so the shell's link goes straight to the router. This is
 * also why the buffering in `deepLinkStore` matters: the shell flushes links
 * that arrived during a cold start the moment the page loads, which can be
 * before this line runs, and `listen` replays the one that was waiting.
 */
deepLinkStore.listen((link) => {
  if (link.kind !== "thread") return
  void router.navigate({
    to: "/chat/$threadId",
    params: { threadId: link.threadId as ThreadId },
  })
})

const root = document.getElementById("root")
if (!root) throw new Error("#root is missing from index.html")

createRoot(root).render(
  <StrictMode>
    <RuntimeProvider value={runtime}>
      <RouterProvider router={router} />
    </RuntimeProvider>
  </StrictMode>,
)
