import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Builds `out/Evie.app`.
 *
 * Everything an app calls itself on macOS -- the dock name and tooltip, the
 * menu bar title, the Finder icon, the name in a permission prompt -- is read
 * by AppKit from the running bundle's `Info.plist`, not from anything the
 * process can set at runtime. `app.setName("Evie")` fixes the notification
 * sender, the About panel, and `userData`, and cannot touch any of the above.
 * So running from a checkout is always "Electron", and the only fix is to be a
 * bundle.
 *
 * This is deliberately not `electron-builder`. It does the one thing that makes
 * the app *itself* -- a bundle with our name, icon, identifier, and URL scheme --
 * and stops short of DMGs, signing identities, notarisation, and update feeds,
 * which are a distribution problem rather than an identity one. When a real
 * packager is wired up it replaces this file; until then this is what makes
 * `Evie.app` a thing you can double-click.
 *
 * The result is unsigned beyond an ad-hoc signature. It runs on the machine
 * that built it and nowhere else.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const OUT = join(ROOT, "out")
const APP = join(OUT, "Evie.app")
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "Electron.app")

const NAME = "Evie"
const BUNDLE_ID = "ai.tryevie.desktop"
const VERSION = JSON.parse(
  execFileSync("cat", [join(ROOT, "package.json")], { encoding: "utf8" }),
).version

if (process.platform !== "darwin") {
  console.log("package: macOS only for now; skipping")
  process.exit(0)
}
if (!existsSync(ELECTRON)) {
  console.error(`package: no Electron at ${ELECTRON}. Run \`bun i\` first.`)
  process.exit(1)
}
if (!existsSync(join(OUT, "main.cjs")) || !existsSync(join(OUT, "server.mjs"))) {
  console.error("package: no bundles in out/. Run `bun run bundle` first.")
  process.exit(1)
}

// `stdio: pipe` because the `Set`-then-`Add` fallback below makes PlistBuddy
// print "Does Not Exist" to stderr on every key it is about to create, which
// reads like a build failure and is not one.
const plist = (file, ...args) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", ...args, file], { stdio: "pipe" })
const set = (file, key, value) => {
  // `Set` fails on a key that does not exist yet; `Add` fails on one that does.
  try {
    plist(file, `Set :${key} ${value}`)
  } catch {
    plist(file, `Add :${key} string ${value}`)
  }
}

/* --- the bundle --------------------------------------------------------------- */

rmSync(APP, { recursive: true, force: true })
cpSync(ELECTRON, APP, { recursive: true, verbatimSymlinks: true })

const contents = join(APP, "Contents")
renameSync(join(contents, "MacOS", "Electron"), join(contents, "MacOS", NAME))

const info = join(contents, "Info.plist")
set(info, "CFBundleName", NAME)
set(info, "CFBundleDisplayName", NAME)
set(info, "CFBundleExecutable", NAME)
set(info, "CFBundleIdentifier", BUNDLE_ID)
set(info, "CFBundleIconFile", "icon.icns")
set(info, "CFBundleShortVersionString", VERSION)
set(info, "CFBundleVersion", VERSION)

/*
 * `evie://` registered on the bundle, which is what makes a link clicked in
 * another app reach us. `app.setAsDefaultProtocolClient` at runtime only works
 * unpackaged, and only for the process that called it.
 */
try {
  plist(info, "Delete :CFBundleURLTypes")
} catch {
  /* not present, which is the normal case */
}
plist(info, "Add :CFBundleURLTypes array")
plist(info, "Add :CFBundleURLTypes:0 dict")
plist(info, `Add :CFBundleURLTypes:0:CFBundleURLName string ${BUNDLE_ID}`)
plist(info, "Add :CFBundleURLTypes:0:CFBundleURLSchemes array")
plist(info, "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string evie")

/*
 * The helpers show up in Activity Monitor and in permission prompts ("Electron
 * Helper would like to access…"), so they are renamed too. Their executable
 * name must match `CFBundleExecutable`, and the framework looks them up by the
 * `.app` directory name, so all three move together.
 */
const frameworks = join(contents, "Frameworks")
for (const suffix of ["", " (GPU)", " (Plugin)", " (Renderer)"]) {
  const from = join(frameworks, `Electron Helper${suffix}.app`)
  if (!existsSync(from)) continue
  const to = join(frameworks, `${NAME} Helper${suffix}.app`)
  renameSync(from, to)
  renameSync(
    join(to, "Contents", "MacOS", `Electron Helper${suffix}`),
    join(to, "Contents", "MacOS", `${NAME} Helper${suffix}`),
  )
  const helperInfo = join(to, "Contents", "Info.plist")
  set(helperInfo, "CFBundleName", `${NAME} Helper${suffix}`)
  set(helperInfo, "CFBundleDisplayName", `${NAME} Helper${suffix}`)
  set(helperInfo, "CFBundleExecutable", `${NAME} Helper${suffix}`)
  set(helperInfo, "CFBundleIdentifier", `${BUNDLE_ID}.helper${suffix.toLowerCase().replace(/[^a-z]/g, "")}`)
}

/* --- the payload -------------------------------------------------------------- */

const resources = join(contents, "Resources")
cpSync(join(OUT, "icon.icns"), join(resources, "icon.icns"))

// `paths.ts` reads `process.resourcesPath` when packaged, so these sit directly
// in Resources rather than in the asar-style `app/` subdirectory.
for (const file of ["main.cjs", "preload.cjs", "server.mjs", "trayTemplate.png", "trayTemplate@2x.png", "icon.png"]) {
  if (existsSync(join(OUT, file))) cpSync(join(OUT, file), join(resources, file))
}
rmSync(join(resources, "web"), { recursive: true, force: true })
if (existsSync(join(OUT, "web"))) cpSync(join(OUT, "web"), join(resources, "web"), { recursive: true })

// Electron looks for `Resources/app/package.json` and its `main`. Everything it
// loads is one directory up, which keeps the payload flat for `paths.ts`.
const appDir = join(resources, "app")
mkdirSync(appDir, { recursive: true })
/*
 * `devHome` is what stops a bundle built in a checkout from opening the
 * developer's real database the moment somebody double-clicks it.
 *
 * `app.isPackaged` is true for this bundle, and a packaged Evie is *supposed*
 * to be the live install -- which is correct for a release and wrong for the
 * artifact sitting in `out/`. Stamping the checkout's own `.evie` here is the
 * one place that can tell the two apart, because it is the only step that
 * knows it ran inside a workspace. A real release pipeline omits it and the
 * app resolves `~/.evie` as it should.
 */
writeFileSync(
  join(appDir, "package.json"),
  `${JSON.stringify(
    {
      name: "evie",
      productName: NAME,
      version: VERSION,
      main: "../main.cjs",
      devHome: join(ROOT, "..", "..", ".evie"),
    },
    null,
    2,
  )}\n`,
)

/* --- signature ----------------------------------------------------------------
 * Apple Silicon refuses to launch a bundle whose signature no longer matches
 * its contents, and every rename above invalidated Electron's. Ad-hoc (`-`) is
 * enough to run locally; a real identity is what notarisation needs and is not
 * this script's job. */

try {
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", APP], { stdio: "pipe" })
  console.log("package: signed ad-hoc")
} catch (error) {
  console.warn(`package: ad-hoc signing failed (${error.message}) — the app may refuse to launch`)
}

console.log(`package: ${APP}`)
