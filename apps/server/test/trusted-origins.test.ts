import { describe, expect, it } from "vitest"
import type { EvieConfigShape } from "../src/config.ts"
import { deriveTrustedOrigins } from "../src/auth/instance.ts"

/**
 * Which origins Better Auth will answer for.
 *
 * The dev web server is a *different origin* from the API server: Vite serves
 * the app on its own port and proxies `/api`, `/blob` and `/rpc` through. So
 * every auth request under `turbo dev` arrives claiming the web origin, and if
 * that is not trusted Better Auth answers `Invalid origin`, the claim cannot be
 * redeemed, and the app runs with no session — while the WebSocket upgrade
 * itself succeeds, which points debugging in entirely the wrong direction.
 *
 * That is worth stating plainly because it was misdiagnosed for a long time as
 * "Vite's WebSocket proxy does not forward the upgrade". The proxy was fine.
 *
 * The trust is deliberately narrow: loopback only, local mode only.
 */

const config = (over: Partial<EvieConfigShape> = {}): EvieConfigShape =>
  ({
    home: {} as EvieConfigShape["home"],
    bind: "127.0.0.1",
    port: 3001,
    mode: "local",
    idleStopMinutes: 10,
    flags: { persistReasoning: false },
    ...over,
  }) as EvieConfigShape

/** `EVIE_WEB_PORT` is read at call time, so it is set and restored per case. */
const withWebPort = <A>(value: string | undefined, body: () => A): A => {
  const previous = process.env["EVIE_WEB_PORT"]
  if (value === undefined) delete process.env["EVIE_WEB_PORT"]
  else process.env["EVIE_WEB_PORT"] = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete process.env["EVIE_WEB_PORT"]
    else process.env["EVIE_WEB_PORT"] = previous
  }
}

describe("trusted origins", () => {
  it("always trusts its own loopback address, both spellings", () => {
    const origins = withWebPort(undefined, () => deriveTrustedOrigins(config()))
    expect(origins).toContain("http://127.0.0.1:3001")
    expect(origins).toContain("http://localhost:3001")
  })

  /* The regression: `turbo dev` serves the app from another port. */
  it("trusts the dev web origin in local mode", () => {
    const origins = withWebPort("3000", () => deriveTrustedOrigins(config()))
    expect(origins).toContain("http://localhost:3000")
    expect(origins).toContain("http://127.0.0.1:3000")
  })

  it("honours a moved dev server", () => {
    const origins = withWebPort("5173", () => deriveTrustedOrigins(config()))
    expect(origins).toContain("http://localhost:5173")
    expect(origins).not.toContain("http://localhost:3000")
  })

  it("does not duplicate when the web port is the server's own", () => {
    const origins = withWebPort("3001", () => deriveTrustedOrigins(config()))
    expect(origins).toEqual(["http://127.0.0.1:3001", "http://localhost:3001"])
  })

  it("ignores a web port that is not a number", () => {
    const origins = withWebPort("not-a-port", () => deriveTrustedOrigins(config()))
    expect(origins).toEqual(["http://127.0.0.1:3001", "http://localhost:3001"])
  })

  /*
   * A server reachable from a network gets no dev indulgence: the argument for
   * trusting another loopback port is that every process on the machine can
   * already reach this one, and that argument stops at the machine's edge.
   */
  it("grants nothing extra once the server is not loopback-only", () => {
    const origins = withWebPort("3000", () =>
      deriveTrustedOrigins(config({ mode: "lan", bind: "0.0.0.0" })),
    )
    expect(origins).not.toContain("http://localhost:3000")
  })
})
