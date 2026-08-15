import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { shell as electronShell } from "electron"
import { resolveHome } from "@evie/shared/home"
import { evieHome } from "./paths.ts"

/**
 * Where the shell writes down what happened.
 *
 * A packaged app has no terminal. Everything the shell and its server child
 * printed went to a stdout nobody was reading -- launched from Finder there is
 * not even a stream on the other end -- which is why the tray's failure label
 * could only point at Console.app, and be wrong about it. Both sides land in
 * one file instead, interleaved in the order they happened, because "the server
 * died four lines after the shell asked it to start" is the whole diagnosis.
 *
 * Writes are synchronous against a descriptor held open. A log exists to
 * survive the crash that makes you go looking for it, and a buffered stream
 * loses exactly the last lines that say why; keeping the descriptor open is
 * what keeps the price of being unbuffered at one `write` per line.
 */

/** Rotate at 2 MB, keeping one previous file. This is read by a person, by hand. */
const MAX_BYTES = 2_000_000

export class EvieLog {
  /**
   * Beside the database, so a run's log sits with the state that run produced.
   *
   * Resolved through the shared layout from the same `EVIE_HOME` the server
   * child is spawned with, rather than by joining `"userdata"` here -- one
   * definition of where things live, and the shell lands wherever the server
   * lands even when an override moves it.
   */
  readonly path = join(resolveHome({ EVIE_HOME: evieHome().path }).userdata, "desktop.log")

  #fd: number | null = null
  /** Bytes in the open file, seeded from it and tracked so rotation costs no `stat`. */
  #size = 0
  /** A log that cannot be opened must not try again on every line. */
  #broken = false

  /** The shell's own messages. */
  shell(message: string): void {
    this.#write(`[shell] ${message}`)
  }

  /** One line the server child printed, verbatim. */
  server(line: string): void {
    // The server prints blank lines between its boot banners; they cost a line
    // in the file each and say nothing.
    if (line.trim().length === 0) return
    this.#write(`[server] ${line}`)
  }

  /** Selects the log in Finder -- the tray's answer to "what happened?". */
  reveal(): void {
    // Asked for a path that does not exist, Finder does nothing at all rather
    // than saying so, so make sure there is a file to select first.
    this.#open()
    electronShell.showItemInFolder(this.path)
  }

  #write(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`
    // Still mirrored: run from a checkout and the terminal is where you are
    // already looking. Packaged it goes nowhere, which is what the file is for.
    process.stdout.write(line)
    const fd = this.#open()
    if (fd === null) return
    try {
      this.#size += writeSync(fd, line)
    } catch {
      // Whatever went wrong with the descriptor, the next line reopens it.
      this.#close()
      return
    }
    if (this.#size >= MAX_BYTES) this.#rotate()
  }

  #open(): number | null {
    if (this.#fd !== null) return this.#fd
    if (this.#broken) return null
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const fd = openSync(this.path, "a")
      this.#fd = fd
      this.#size = fstatSync(fd).size
      return fd
    } catch {
      // A shell that cannot write its log still has a server to run.
      this.#broken = true
      return null
    }
  }

  /**
   * One previous file, replaced in place. Two files bound the cost at twice
   * `MAX_BYTES`, and nobody has ever wanted the fourth-oldest shell log. The
   * next write reopens, and reseeds `#size` from whatever it finds.
   */
  #rotate(): void {
    this.#close()
    try {
      renameSync(this.path, `${this.path}.1`)
    } catch {
      /* nothing to move; the next write starts a fresh file either way */
    }
  }

  #close(): void {
    const fd = this.#fd
    this.#fd = null
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      /* already gone */
    }
  }
}
