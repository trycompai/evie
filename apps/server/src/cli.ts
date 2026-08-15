import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { AppLive } from "./layer.ts"

/**
 * `npx evie`: the same server `main.ts` boots, plus the two things a published
 * command needs that a dev process does not -- an argument parser, and knowing
 * where its own files are.
 *
 * Every flag lands in the environment rather than in a second config path.
 * `config.ts` already resolves `defaults < settings.json < environment` and
 * calls the environment the operator's word; a command line is exactly that, so
 * it belongs at the top of the ladder that already exists. Nothing here reads
 * config, and the boot below is `main.ts` verbatim.
 */

const HELP = `Usage: evie [options]

Runs an Evie server and serves the web app from the same origin. On a loopback
bind it prints a one-time claim URL -- open it to sign in to this machine.

Options:
  -p, --port <port>   Port to listen on (default 3773)
  -h, --help          Show this message

Environment:
  EVIE_HOME           Data directory (default ~/.evie)
  EVIE_BIND           Interface to bind (default 127.0.0.1). Binding anywhere
                      else makes this a LAN or tunnel server, and no claim URL
                      is printed -- pair from an already signed-in client.
  EVIE_WEB_DIST       Web app to serve (default: the copy beside this file)
`

type Parsed =
  | { readonly kind: "run"; readonly port: number | undefined }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }

/**
 * Returns what to do instead of doing it, so the one place that writes to a
 * stream and picks an exit code is the block below. A bad argv is a typo, and a
 * typo deserves a sentence rather than a stack trace.
 */
const parse = (argv: readonly string[]): Parsed => {
  let port: number | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === "-h" || arg === "--help") return { kind: "help" }
    if (arg === "-p" || arg === "--port" || arg.startsWith("--port=")) {
      let raw: string | undefined
      if (arg.startsWith("--port=")) {
        raw = arg.slice("--port=".length)
      } else {
        i += 1
        raw = argv[i]
      }
      const value = Number(raw)
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { kind: "error", message: `--port wants 1-65535, got ${raw ?? "nothing"}` }
      }
      port = value
      continue
    }
    return { kind: "error", message: `Unknown option ${arg}` }
  }
  return { kind: "run", port }
}

const parsed = parse(process.argv.slice(2))
if (parsed.kind === "help") {
  console.log(HELP)
  process.exit(0)
}
if (parsed.kind === "error") {
  console.error(`evie: ${parsed.message}\n\n${HELP}`)
  process.exit(1)
}

if (parsed.port !== undefined) process.env["EVIE_PORT"] = String(parsed.port)

/**
 * The build copies `apps/web/dist` next to the bundle, so the app, the RPC
 * socket, and the auth cookie share one origin. Missing it is a broken build
 * rather than a mode -- say so, and still serve the API, because a running
 * server the user can reach with a desktop client beats refusing to start.
 */
const bundledWeb = join(dirname(fileURLToPath(import.meta.url)), "web")
if (process.env["EVIE_WEB_DIST"] === undefined) {
  if (existsSync(bundledWeb)) process.env["EVIE_WEB_DIST"] = bundledWeb
  else console.error(`evie: no web app at ${bundledWeb}; serving the API only.`)
}

/**
 * This command *is* the install, so `~/.evie` is its home and the guard that
 * stops a worktree from opening the developer's real database does not apply to
 * it. An explicit `EVIE_HOME` leaves the guard armed, the same way the
 * unpackaged desktop shell does: pointing it back at `~/.evie` by hand is the
 * mistake the guard is for, and this is not that.
 */
if (process.env["EVIE_HOME"] === undefined) process.env["EVIE_ALLOW_LIVE_HOME"] = "1"

// `main.ts`'s line rather than an import of it: ESM hoists imports above every
// assignment above, so an imported entry point would launch against the
// environment this file has not set yet.
NodeRuntime.runMain(Layer.launch(AppLive))
