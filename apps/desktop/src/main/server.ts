import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { readServerClaim } from "@evie/server/home-lock"
import { evieHome, serverEntry, webDist } from "./paths.ts"
import type { ServerStatus } from "@evie/shared/desktop-bridge"

/**
 * The Evie server, owned as a child process.
 *
 * Electron's main process is a poor host for a server that has to outlive a
 * window and survive a renderer crash, so the shell spawns one instead of
 * importing one. It is hosted by Electron's *own* binary in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`): Electron 40 embeds Node 24 with `node:sqlite`
 * compiled in, which is the server's one hard runtime requirement, so the
 * packaged app needs no system Node and no second runtime shipped beside it.
 *
 * `AGENTS.md` rule 1 -- never kill a process you found by matching a pattern --
 * is a shipped-product rule here, not just a development one. This module holds
 * the `ChildProcess` it created and signals that, and nothing else, ever.
 */

const READY = /Evie is ready:\s+(https?:\/\/[^\s"']+)/
/** Prefixes a structured line the server writes for the shell. See `notifications.ts`. */
export const NOTIFY_PREFIX = "@@evie-notify@@ "

/** Restarts are for crashes. Five in a row means the next one will crash too. */
const MAX_RESTARTS = 5
const RESTART_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000]
/** After SIGTERM, how long the server gets to close its database cleanly. */
const SHUTDOWN_GRACE_MS = 4_000

export interface ServerHandle {
  /** Origin only -- no claim token. What a reload should navigate to. */
  readonly origin: string
  /** `origin/?claim=<token>`: single-use, 60 s, and only valid for a first load. */
  readonly claimUrl: string
}

/**
 * Where the window loads the UI from, when that is not the server itself.
 *
 * A server started by `turbo dev` sets no `EVIE_WEB_DIST`, so it serves the API
 * and no app -- adopting it and loading its origin would open a blank window.
 * The Vite dev server has the UI *and* proxies `/api`, `/blob` and `/rpc` to
 * that same server, so in dev the window points there and gets hot reload into
 * the bargain. Same-origin either way, which is what the session cookie needs.
 */
const adoptedWebOrigin = (): string | null => {
  const url = process.env["EVIE_ADOPT_WEB_URL"]
  return url !== undefined && url.length > 0 ? url.replace(/\/$/, "") : null
}

export interface ServerOptions {
  readonly onStatus: (status: ServerStatus) => void
  readonly onNotify: (line: string) => void
  /** Every stdout/stderr line, for the log file and the dev console. */
  readonly onLog: (line: string) => void
}

export class EvieServer {
  #child: ChildProcess | null = null
  /** Captured at spawn. The only pid this class will ever signal. */
  #pid: number | null = null
  #handle: ServerHandle | null = null
  #restarts = 0
  #stopping = false
  #buffers = { out: "", err: "" }
  /** Resolved with the first ready line of the *current* boot. */
  #ready: { promise: Promise<ServerHandle>; resolve: (handle: ServerHandle) => void; reject: (error: Error) => void }

  /**
   * Lets the shell mint a fresh session at any time without restarting the
   * server. Claim tokens are single-use and expire in 60 s, so without this a
   * window that outlives its cookie has no way back in short of killing the
   * server and every agent running under it.
   */
  launcherToken = randomBytes(32).toString("base64url")

  constructor(private readonly options: ServerOptions) {
    this.#ready = deferred()
  }

  get handle(): ServerHandle | null {
    return this.#handle
  }

  /**
   * True when this shell adopted a server it did not start.
   *
   * Quitting must then leave it running: it belongs to whoever did start it,
   * and killing another process's server on the way out is the rudest possible
   * interpretation of "close the window".
   */
  #adopted = false
  /** Where the launcher API lives. Differs from the window's origin only when adopting a dev server. */
  #apiOrigin: string | null = null

  /**
   * Resolves when a server is serving this home -- adopted or spawned.
   *
   * Adoption is what lets the app open beside `turbo dev` instead of competing
   * with it. Two servers on one home both spawn `eve dev` in the same bot
   * directory; eve dedupes to one runtime and the server that did not start it
   * gets 401 on every turn. So if the home is already served, join it.
   */
  async start(): Promise<ServerHandle> {
    const existing = await this.#adopt()
    if (existing !== null) return existing
    this.#spawn()
    return this.#ready.promise
  }

  /**
   * The server already serving this home, if it is alive and answering.
   *
   * `evie.lock` carries the URL and the launcher token, so adoption needs no
   * port guessing and no second auth path -- the same `/internal/launcher/claim`
   * a spawned server would have used.
   */
  async #adopt(): Promise<ServerHandle | null> {
    /*
     * `turbo dev` starts this app and the server at the same moment, so a
     * single look at the lock usually loses the race. The dev script sets a
     * wait; a standalone launch does not, and starts its own server at once
     * rather than pausing for one that is never coming.
     */
    const budget = Number(process.env["EVIE_ADOPT_WAIT_MS"] ?? 0)
    const deadline = Date.now() + (Number.isFinite(budget) ? budget : 0)
    let claim = readServerClaim(join(evieHome().path, "userdata"))
    while (claim === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      claim = readServerClaim(join(evieHome().path, "userdata"))
    }
    if (claim === null) return null
    const healthy = await fetch(`${claim.url}/health`)
      .then((response) => response.ok)
      .catch(() => false)
    // A claim whose server does not answer is a crash we should replace, not join.
    if (!healthy) return null

    this.#adopted = true
    this.launcherToken = claim.launcherToken
    this.#apiOrigin = claim.url
    const origin = adoptedWebOrigin() ?? claim.url
    // Provisional, so `freshClaimUrl` below has an origin to build against.
    this.#handle = { origin, claimUrl: origin }
    /*
     * An adopted server printed its own claim URL long before this window
     * existed, and that token is single-use and 60 seconds old at best. Mint a
     * fresh one now, or the first load arrives unauthenticated and the window
     * opens on the sign-in screen for no reason the user can see.
     */
    const handle: ServerHandle = { origin, claimUrl: (await this.freshClaimUrl()) ?? origin }
    this.#handle = handle
    this.options.onLog(`adopted the server already serving this home (pid ${claim.pid})`)
    this.options.onStatus({ kind: "ready", origin: handle.origin })
    return handle
  }

  /**
   * A fresh `?claim=` URL from the running server, for a window that lost its
   * cookie. Returns null if the server is not up or refuses -- the caller falls
   * back to loading the bare origin and letting the app show its sign-in state.
   */
  async freshClaimUrl(): Promise<string | null> {
    const handle = this.#handle
    if (handle === null) return null
    const api = this.#apiOrigin ?? handle.origin
    try {
      const response = await fetch(`${api}/internal/launcher/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.launcherToken}` },
      })
      if (!response.ok) return null
      const body = (await response.json()) as { url?: unknown }
      if (typeof body.url !== "string") return null
      // The server names itself in that URL. When the window lives on a dev
      // origin, carry the token across rather than sending it to the wrong host.
      const token = new URL(body.url).searchParams.get("claim")
      if (token === null) return body.url
      return `${handle.origin}/?claim=${encodeURIComponent(token)}`
    } catch {
      return null
    }
  }

  /**
   * Signals the child and returns immediately, for use from a signal handler.
   *
   * `stop()` awaits the child's exit, and awaiting anything inside a SIGTERM
   * handler is a race the shell loses: the process can be torn down before the
   * first `await` resumes, and the server is left orphaned holding the port --
   * which is exactly what happened before this existed. Signalling first and
   * asking questions later is the only ordering that survives.
   */
  stopNow(): void {
    this.#stopping = true
    if (this.#adopted) return
    const pid = this.#pid
    if (pid === null) return
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }

  /**
   * SIGTERM, then SIGKILL if it is still there. Signals `#pid`, captured at
   * spawn -- never a pid found by name. Safe to call twice.
   */
  async stop(): Promise<void> {
    this.#stopping = true
    if (this.#adopted) return
    const child = this.#child
    const pid = this.#pid
    this.#child = null
    this.#pid = null
    this.#handle = null
    if (child === null || pid === null || child.exitCode !== null) return

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      return
    }
    const timer = setTimeout(() => {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already gone */
      }
    }, SHUTDOWN_GRACE_MS)
    await exited
    clearTimeout(timer)
  }

  #spawn(): void {
    const home = evieHome()
    if (!existsSync(serverEntry)) {
      this.#fail(`No server bundle at ${serverEntry}. Run \`bun run build\` in apps/desktop.`)
      return
    }

    this.options.onStatus({ kind: "starting" })

    const child = spawn(
      process.execPath,
      [serverEntry],
      {
        // `ELECTRON_RUN_AS_NODE` turns this same binary into plain Node 24.
        // `extendEnv` is implicit: the server passes its environment down to
        // the agent runtimes it spawns, which is how a key exported in the
        // user's shell reaches a bot today.
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          EVIE_HOME: home.path,
          ...(home.live ? { EVIE_ALLOW_LIVE_HOME: "1" } : {}),
          EVIE_WEB_DIST: webDist,
          EVIE_LAUNCHER_TOKEN: this.launcherToken,
          // The backstop for the one case no handler here can cover: if this
          // shell is SIGKILLed, the server notices its parent is gone and
          // exits itself rather than holding the port forever.
          EVIE_PARENT_PID: String(process.pid),
          // Turns `Notifier.layerNoop` into a real transport: the reactor
          // decides when to notify, the shell only delivers.
          EVIE_NOTIFY_STDOUT: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    this.#child = child
    this.#pid = child.pid ?? null
    this.#buffers = { out: "", err: "" }

    child.stdout?.on("data", (chunk: Buffer) => this.#consume("out", chunk))
    child.stderr?.on("data", (chunk: Buffer) => this.#consume("err", chunk))
    child.once("error", (error) => this.#fail(error.message))
    child.once("exit", (code, signal) => this.#onExit(code, signal))
  }

  /** Line-buffers a stream: a ready line can arrive split across two chunks. */
  #consume(stream: "out" | "err", chunk: Buffer): void {
    const text = this.#buffers[stream] + chunk.toString("utf8")
    const lines = text.split("\n")
    this.#buffers[stream] = lines.pop() ?? ""
    for (const line of lines) this.#line(line)
  }

  #line(line: string): void {
    if (line.startsWith(NOTIFY_PREFIX)) {
      this.options.onNotify(line.slice(NOTIFY_PREFIX.length))
      return
    }
    this.options.onLog(line)
    const match = READY.exec(line)
    if (match?.[1] === undefined) return

    const url = new URL(match[1])
    const handle: ServerHandle = { origin: url.origin, claimUrl: url.toString() }
    this.#handle = handle
    this.#restarts = 0
    this.options.onStatus({ kind: "ready", origin: handle.origin })
    this.#ready.resolve(handle)
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#stopping) return
    this.#handle = null
    this.options.onLog(`server exited (code=${code ?? "null"} signal=${signal ?? "null"})`)

    if (this.#restarts >= MAX_RESTARTS) {
      this.#fail(`The Evie server exited ${MAX_RESTARTS} times in a row (last code ${code ?? "unknown"}).`)
      return
    }
    const attempt = ++this.#restarts
    // A fresh deferred: whoever awaits `start()` next wants *this* boot.
    this.#ready = deferred()
    this.options.onStatus({ kind: "restarting", attempt })
    setTimeout(() => {
      if (!this.#stopping) this.#spawn()
    }, RESTART_BACKOFF_MS[attempt - 1] ?? 4_000)
  }

  #fail(reason: string): void {
    this.options.onStatus({ kind: "failed", reason })
    this.#ready.reject(new Error(reason))
  }
}

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nothing awaits a boot that a later boot replaced; without this an
  // abandoned rejection takes the whole process down as an unhandled rejection.
  promise.catch(() => {})
  return { promise, resolve, reject }
}
