import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { AppLive } from "./layer.ts"

/**
 * The entry point. `Layer.launch` builds the whole composition -- migrations,
 * reactor replay, then the listening gateway -- and parks forever; teardown
 * (SIGINT via `runMain`) closes the layer scope, which is the only way any
 * child process or fiber in this tree is ever stopped.
 */
NodeRuntime.runMain(Layer.launch(AppLive))
