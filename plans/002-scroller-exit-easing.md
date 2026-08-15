# 002 — Scroll-pill exit: ease-out and inside the duration budget

- **Status**: DONE (applied after the review-animations pass flagged it; feel-check in a real client still pending — step 3 of the plan)
- **Commit**: 90ff92757
- **Severity**: MEDIUM
- **Category**: Easing & duration
- **Estimated scope**: 1 file, two utility tokens

## Problem

The message-scroller's jump-to-latest pill exits with an ease-in curve over 400ms. The
motion bar this repo audits against says exits use ease-out (an ease-in start delays the
change the user is watching) and UI animations stay under 300ms. The pill appears and
disappears tens of times a day while scrolling a thread, so a 400ms lingering exit is paid
constantly.

```tsx
// packages/ui/src/components/message-scroller.tsx:100 — current (fragment of one long
// className; these two tokens are the finding)
"... data-[active=false]:duration-400 data-[active=false]:ease-in ..."
```

The enter side is already correct: `duration-200` with `ease-out`
(`--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, defined in
`packages/ui/src/styles/globals.css`).

**Honesty note**: the ease-in exit may have been a deliberate "recede and vanish" choice.
It is not documented as one anywhere in the file or docs, so it is reported — but the feel
check below decides. If the symmetric version feels worse in motion, keep the original and
mark this plan WONTFIX with a comment added at the line explaining the choice, so the next
audit skips it.

## Target

```tsx
// packages/ui/src/components/message-scroller.tsx:100 — target fragment
"... data-[active=false]:duration-200 data-[active=false]:ease-out ..."
```

With both directions on `ease-out`/`duration-200`, the per-state duration and easing
overrides collapse into the base `transition-[translate,scale,opacity] duration-200`
declaration — after the swap, remove `data-[active=false]:duration-400`,
`data-[active=false]:ease-in`, and `data-[active=true]:ease-out` entirely and add a plain
`ease-out` next to `duration-200` in the base. Fewer tokens, same result.

## Repo conventions to follow

- Easing tokens live in `packages/ui/src/styles/globals.css` (`--ease-out`, `--ease-in`)
  and are exposed as the Tailwind `ease-out` / `ease-in` utilities. Use the utilities, not
  arbitrary `ease-[cubic-bezier(...)]` values.
- Exemplar: `packages/ui/src/components/dialog.tsx` uses
  `transition-[opacity,scale] duration-200 ease-out` with a faster
  `data-[ending-style]:duration-150` exit.
- If this removes the last usage of the `ease-in` utility in the repo, leave the
  `--ease-in` token in globals.css but note it in the PR/summary so a maintainer can decide
  whether to drop it.

## Steps

1. In `packages/ui/src/components/message-scroller.tsx:100`, remove the three tokens
   `data-[active=false]:duration-400`, `data-[active=false]:ease-in`, and
   `data-[active=true]:ease-out` from the className.
2. In the same className, change `transition-[translate,scale,opacity] duration-200` to
   `transition-[translate,scale,opacity] duration-200 ease-out`.
3. Run the feel check. If the original exit feels better, revert steps 1–2, add a one-line
   comment above the className documenting the deliberate ease-in exit, and set this plan's
   status to WONTFIX.

## Boundaries

- Do NOT touch the pill's enter values, positioning tokens, or hover styles.
- Do NOT change `message-scroller.tsx` beyond this one className.
- Do NOT add new dependencies or tokens.
- If the className no longer contains `data-[active=false]:ease-in` (drift since
  90ff92757), STOP and report instead of improvising.

## Verification

- **Mechanical**: `turbo run lint check-types --filter=@evie/ui` passes.
- **Feel check**: open a long thread, scroll up so the pill appears, then jump back down so
  it exits:
  - the pill starts leaving immediately on dismissal (no lingering hold before it moves);
  - in DevTools → Animations at 10% playback, the exit decelerates (fast start, soft end);
  - spam-scrolling across the threshold retargets smoothly — the pill never restarts from
    fully hidden mid-flight (transitions, not keyframes, so this should hold).
- **Done when**: both directions of the pill run 200ms on `ease-out` — or the plan is
  marked WONTFIX with the documenting comment in place.
