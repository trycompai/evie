# Animation plans

Written by the `improve-animations` audit at commit 90ff92757 (2026-08-15). Each plan is
self-contained: an executor needs no context beyond the plan file.

| # | Plan | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Replace `transition-all` on the dense Button](001-button-transition-all.md) | HIGH | TODO |
| 002 | [Scroll-pill exit: ease-out, inside budget](002-scroller-exit-easing.md) | MEDIUM | DONE (feel-check pending) |
| 003 | [Chevron rotations onto the shared ease-out token](003-chevron-easing-token.md) | LOW | TODO |

## Execution order

001 → 002 → 003, by leverage. No dependencies between plans; they touch disjoint files and
can run in any order or in parallel.

## Deliberate non-findings (do not "fix" these)

- `context-meter.tsx` has no transition — documented as deliberate in the component.
- The global `prefers-reduced-motion` flatten in globals.css is a documented product rule.
- The timeline renders with zero motion — deliberate; it is hand-virtualized and
  height-animating anything inside it fights the ResizeObserver machinery.
- The `evie-thinking` steps() ticker is the one sanctioned looping animation.
- Two press idioms coexist (dense Button `active:translate-y-px`, large controls
  `active:scale-[0.97]`) — different control sizes, both subtle; not drift.
