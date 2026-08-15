import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
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
  readonly launcherToken = randomBytes(32).toString("base64url")

  constructor(private readonly options: ServerOptions) {
    this.#ready = deferred()
  }

  get handle(): ServerHandle | null {
    return this.#handle
  }

  /** Resolves when the server prints its ready line; rejects if it dies first. */
  start(): Promise<ServerHandle> {
    this.#spawn()
    return this.#ready.promise
  }

  /**
   * A fresh `?claim=` URL from the running server, for a window that lost its
   * cookie. Returns null if the server is not up or refuses -- the caller falls
   * back to loading the bare origin and letting the app show its sign-in state.
   */
  async freshClaimUrl(): Promise<string | null> {
    const handle = this.#handle
    if (handle === null) return null
    try {
      const response = await fetch(`${handle.origin}/internal/launcher/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.launcherToken}` },
      })
      if (!response.ok) return null
      const body = (await response.json()) as { url?: unknown }
      return typeof body.url === "string" ? body.url : null
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
