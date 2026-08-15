# 003 — Chevron rotations onto the shared ease-out token

- **Status**: TODO
- **Commit**: 90ff92757
- **Severity**: LOW
- **Category**: Cohesion & tokens
- **Estimated scope**: 2 files, one utility each

## Problem

The two expand/collapse chevrons animate with `transition-transform` and no easing
utility, so they fall back to Tailwind's default timing function — a weak built-in curve —
while every other deliberate motion in the app now runs on the shared strong tokens
(`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` in `packages/ui/src/styles/globals.css`).
Two curves for the same personality is drift.

```tsx
// packages/ui/src/components/tool-call-row.tsx:78 — current
<ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
```

```tsx
// packages/ui/src/components/reasoning-row.tsx:55 — current
<ChevronRightIcon size={12} className={cn("transition-transform", open && "rotate-90")} />
```

## Target

```tsx
// tool-call-row.tsx:78 — target
<ChevronRightIcon className={cn("transition-transform ease-out", open && "rotate-90")} />
```

```tsx
// reasoning-row.tsx:55 — target
<ChevronRightIcon size={12} className={cn("transition-transform ease-out", open && "rotate-90")} />
```

Duration stays at the default 150ms — correct for a 90° flip on a 12–16px icon. `ease-out`
is chosen over adding an `--ease-in-out` token: the rotation is a response to a click, the
difference is imperceptible at this size, and a new token for two chevrons is not worth
the vocabulary.

## Repo conventions to follow

- The `ease-out` utility resolves to the repo token, not Tailwind's built-in — globals.css
  overrides it deliberately (see the comment at the `--- motion ---` section of
  `packages/ui/src/styles/globals.css`).
- Exemplar of the utility in use: `packages/ui/src/components/action-button.tsx:20`.

## Steps

1. In `packages/ui/src/components/tool-call-row.tsx:78`, change `"transition-transform"`
   to `"transition-transform ease-out"`.
2. In `packages/ui/src/components/reasoning-row.tsx:55`, change `"transition-transform"`
   to `"transition-transform ease-out"`.

## Boundaries

- Do NOT animate the expanding body of either row — the timeline's virtualization measures
  row heights with a ResizeObserver, and height animation would re-derive offsets every
  frame. The chevron is the only motion these rows get.
- Do NOT change durations or add tokens.
- If either line no longer matches (drift since 90ff92757), STOP and report.

## Verification

- **Mechanical**: `turbo run lint check-types --filter=@evie/ui` passes.
- **Feel check**: expand and collapse a tool row and a reasoning row; the chevron flip
  should settle softly instead of moving at near-constant speed. Rapid toggling must
  retarget mid-rotation (transitions retarget; if it ever snaps to 0° first, something
  regressed).
- **Done when**: both chevrons carry `ease-out` and no other motion was added to the rows.
