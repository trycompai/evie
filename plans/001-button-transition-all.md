# 001 — Replace `transition-all` on the dense Button with named properties

- **Status**: TODO
- **Commit**: 90ff92757
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 1 file, one class string

## Problem

The app-wide dense button (toolbars, menus, dialogs) declares `transition-all`, which
animates every animatable property that ever changes on the element — including
layout-affecting ones and properties the author never intended to animate. In a codebase
that audits for GPU spikes and dropped frames, an unnamed transition surface on the most
common control is a standing hazard: any future class added to a Button (a width change, a
padding tweak, a color swap) silently becomes an animation.

```tsx
// packages/ui/src/components/button.tsx:6 — current (one long cva base string; only the
// relevant fragment shown, it appears exactly once)
"... whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring
focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px
disabled:pointer-events-none disabled:opacity-50 ..."
```

What actually changes on this button across its states: `color`, `background-color`,
`border-color`, `box-shadow` (the focus ring), `translate` (the 1px press nudge), and
`opacity` (disabled).

## Target

Name exactly those properties. Everything else about the string stays byte-identical.

```tsx
// packages/ui/src/components/button.tsx:6 — target fragment
"... whitespace-nowrap transition-[color,background-color,border-color,box-shadow,translate,opacity] outline-none select-none ..."
```

Keep the default duration and easing (Tailwind's defaults are what the button uses today;
this plan changes the property list only).

## Repo conventions to follow

- This file is vendored shadcn `base-nova`; the repo adapts vendored strings in place
  rather than wrapping them. Edit the cva base string directly.
- Exemplar of named transition properties in this repo:
  `packages/ui/src/components/questionnaire.tsx:170` uses
  `transition-[color,box-shadow,background-color]`.
- Tailwind v4 in this repo: `translate-y-px` sets the `translate` property (not
  `transform`), so `translate` must be in the list or the press nudge stops animating.

## Steps

1. In `packages/ui/src/components/button.tsx`, in the `buttonVariants` cva base string
   (line 6), replace the single token `transition-all` with
   `transition-[color,background-color,border-color,box-shadow,translate,opacity]`.
   Change nothing else in the string.

## Boundaries

- Do NOT touch any other component or any variant string in this file.
- Do NOT change durations, easings, or add tokens.
- Do NOT add new dependencies.
- If the string at button.tsx:6 no longer contains `transition-all` (drift since
  90ff92757), STOP and report instead of improvising.

## Verification

- **Mechanical**: `turbo run lint check-types --filter=@evie/ui` passes.
- **Feel check**: in the running app (or `apps/web`'s gallery), hover, press, focus, and
  disable a dense Button:
  - hover/press color changes still ease exactly as before;
  - the 1px press nudge (`active:translate-y-px`) still animates — if it snaps, `translate`
    is missing from the property list;
  - the focus ring still transitions.
- **Done when**: no `transition-all` remains in `packages/ui/src`, and the button's five
  state changes visibly animate as before.
