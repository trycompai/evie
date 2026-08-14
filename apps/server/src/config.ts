import { existsSync, readFileSync } from "node:fs"
import type { ConnectionMode } from "@evie/contracts/org"
import { assertNotLiveInstall, resolveHome, type EvieHome } from "@evie/shared/home"
import { Config, Context, Effect, Layer, Option, Schema } from "effect"

/**
 * Process configuration, resolved once at boot.
 *
 * Sources, later wins: defaults < `userdata/settings.json` < environment.
 * The environment is the operator's word and `settings.json` is the user's, so
 * a `EVIE_BIND` on the command line beats whatever Settings wrote.
 */

export interface FeatureFlags {
  /**
   * Persist reasoning text into the event mirror. Default off, and staying off
   * is a product decision (03, "Retention") -- the flag exists so the one
   * branch in the ingestion path has a name.
   */
  readonly persistReasoning: boolean
}

export interface EvieConfigShape {
  readonly home: EvieHome
  readonly bind: string
  readonly port: number
  /** Derived from `bind`, never a stored setting. See `modeOf`. */
  readonly mode: ConnectionMode
  /** Minutes with no active turn and no client before an eve runtime stops. */
  readonly idleStopMinutes: number
  readonly flags: FeatureFlags
}

/**
 * The subset of `settings.json` the server reads. Unknown keys are ignored so
 * clients can keep their own settings in the same file.
 */
const SettingsFile = Schema.Struct({
  bind: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  idleStopMinutes: Schema.optional(Schema.Int),
  flags: Schema.optional(
    Schema.Struct({
      persistReasoning: Schema.optional(Schema.Boolean),
    }),
  ),
})

const decodeSettings = Schema.decodeUnknownSync(SettingsFile)

/**
 * Mode is a property of how the process is bound, not a setting a user can get
 * wrong: loopback is `local`, a wildcard bind is `lan`, and a bind to any other
 * explicit host means something (a tunnel) is fronting us.
 */
export const modeOf = (bind: string): ConnectionMode => {
  if (bind === "localhost" || bind === "::1" || bind.startsWith("127.")) return "local"
  if (bind === "0.0.0.0" || bind === "::") return "lan"
  return "tunnel"
}

const make = Effect.gen(function* () {
  const home = resolveHome()
  // Throws rather than fails: opening the developer's live install is a defect
  // in how the process was started, and nothing downstream may run after it.
  assertNotLiveInstall(home)

  // A malformed settings.json dies loudly at boot instead of silently zeroing
  // the user's settings. A missing one is the normal first run.
  const settings = yield* Effect.sync(() =>
    existsSync(home.settingsPath)
      ? decodeSettings(JSON.parse(readFileSync(home.settingsPath, "utf8")))
      : decodeSettings({}),
  )

  const envBind = yield* Config.option(Config.string("EVIE_BIND"))
  const envPort = yield* Config.option(Config.port("EVIE_PORT"))
  const envIdle = yield* Config.option(Config.int("EVIE_IDLE_STOP_MINUTES"))

  const bind = Option.getOrElse(envBind, () => settings.bind ?? "127.0.0.1")
  const port = Option.getOrElse(envPort, () => settings.port ?? 3773)
  const idleStopMinutes = Option.getOrElse(envIdle, () => settings.idleStopMinutes ?? 10)

  return {
    home,
    bind,
    port,
    mode: modeOf(bind),
    idleStopMinutes,
    flags: {
      persistReasoning: settings.flags?.persistReasoning ?? false,
    },
  } satisfies EvieConfigShape
})

export class EvieConfig extends Context.Service<EvieConfig, EvieConfigShape>()("EvieConfig") {
  static readonly layer = Layer.effect(EvieConfig, make)
}
