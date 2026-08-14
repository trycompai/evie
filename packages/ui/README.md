# @evie/ui

Shared React components for Evie's clients. Built on [shadcn/ui](https://ui.shadcn.com) (Base UI primitives, `base-nova` style) and Tailwind v4.

## Just-in-time, no build step

This package ships TypeScript source. The `exports` map points at `src/` directly, so there is no `build` script, no `dist/`, and nothing for Turborepo to cache here — the consuming app's bundler compiles the components as part of its own build. Editing a component shows up in the app's dev server immediately, with no watcher in between.

The tradeoff: every consumer must be a bundler that understands TSX. That holds for the web and desktop clients, so the simplicity is worth it. If something ever needs to consume this package without a bundler, that consumer is the thing to reconsider, not this package.

## Using it

Add the dependency to the consuming package:

```json
{ "dependencies": { "@evie/ui": "workspace:*" } }
```

Import the stylesheet once at the client's entry point, then import components by subpath:

```tsx
import "@evie/ui/globals.css";

import { Button } from "@evie/ui/components/button";
import { cn } from "@evie/ui/lib/utils";
```

There is no barrel export. Subpath imports keep the app's module graph honest about what it actually uses.

## Adding components

Run the shadcn CLI from this directory so it reads this package's `components.json` and writes to `src/components`:

```bash
cd packages/ui
bun x shadcn@latest add dialog
```

The CLI rewrites imports to the `@evie/ui/*` aliases on the way in. Read what it generated before committing — registry components sometimes arrive with icon imports or composition that don't match our conventions.

Note that `npx` fails at the repo root because the root `package.json` pins bun via `devEngines`. Use `bun x`.

## Class scanning

`src/styles/globals.css` owns the Tailwind entry point, the theme tokens, and the `@source` globs. Those globs are resolved relative to that file and currently cover `apps/*` and every `packages/*/src`. A new workspace package that ships Tailwind classes is covered automatically as long as its source lives under `src/`; anywhere else needs a new `@source` line, or its classes are silently dropped from the build.

## Checks

```bash
bun run lint
bun run check-types
```
