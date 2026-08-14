# The design system, and how it stays 1:1 with the file

`@evie/ui` is a port of the **"Evie" Paper file**, not an interpretation of it.
That is a maintenance claim as much as a visual one, so this file writes down
the mapping — because a port drifts the moment nobody can check it.

## Where the truth is

| Thing | Lives in |
| --- | --- |
| Tokens, type scale, spacing, radius | The Paper file's design tokens |
| Screens | Paper pages `01 Launch` … `07 Plugins` |
| Token definitions in code | [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css) |
| Components | [`packages/ui/src/components/`](../../packages/ui/src/components) |
| Screen compositions | [`apps/web/src/screens/`](../../apps/web/src/screens) |

When the file and the code disagree, **the file wins** unless the divergence is
recorded below.

## Reading a value out of Paper

Never take a size or a colour off a screenshot. Screenshots are for judging the
result; the JSX export is for sourcing the value.

```
get_jsx({ nodeId, format: "inline-styles" })   // exact geometry
get_computed_styles({ nodeIds: [...] })        // anything the JSX elides
get_screenshot({ nodeId })                     // to check your work, after
```

## The one translation

Paper artboards are flat — no theme switching — so its export hardcodes a
`var(--color-dark-*)` per node. In the codebase those are the **dark values of
theme-switching semantic tokens**. That mapping is the only thing the port
changes, and it is mechanical:

| Paper export | Token | Tailwind |
| --- | --- | --- |
| `--color-dark-surface-primary` | `--color-surface-primary` | `bg-surface` / `text-surface` |
| `--color-dark-surface-raised` | `--color-surface-raised` | `bg-raised` |
| `--color-dark-surface-raised-strong` | `--color-surface-raised-strong` | `bg-raised-strong` |
| `--color-dark-text-primary` | `--color-text-primary` | `text-fg` / `bg-fg` |
| `--color-dark-text-secondary` | `--color-text-secondary` | `text-fg-muted` |
| `--color-dark-border-subtle` | `--color-border-subtle` | `border-line-subtle` |
| `--color-dark-border-default` | `--color-border-default` | `border-line` |
| `--color-dark-link` | `--color-link` | `text-link` |

Light values come from Paper's light semantics. Two have no counterpart in the
file — the raised pair, because every artboard is dark — and are picked one and
two steps up the same neutral ramp so the elevation delta reads the same in
both themes. That is called out in `globals.css` rather than left to be
discovered.

## Three token layers, and why the third looks redundant

1. **Primitives** — the raw scale (`--color-gray-500`). Plain CSS in `:root`.
2. **Semantics** — what a primitive means (`--color-surface-raised`). Plain CSS
   in `:root`, overridden in `.dark`.
3. **Aliases** — `@theme inline`, which is what makes Tailwind emit utilities.

Layer 3 contains entries that look like no-ops (`--color-success:
var(--color-success)`). They are not: `@theme inline` registers a name as a
theme entry without re-declaring it, and deleting the "redundant" line deletes
`bg-success`. Layers 1 and 2 stay outside `@theme` because `@theme` tree-shakes
anything no utility references, and a shaken primitive would take the semantic
that referenced it down with it — in light mode only, at build time.

## Off-scale values are allowed, and expected

The design uses 19px line-height in the rail preview, 46px onboarding buttons,
340px button widths, 17px onboarding copy, 620px and 780px column caps. Use
`leading-[19px]`, `h-[46px]`, `w-[340px]`. **Fidelity beats scale purity**; a
component that rounds 19 to 20 to stay on the token scale is a component that
no longer matches the file.

One step the design uses everywhere and never named is 15px — the app's control
size. It is named here as `--text-ui` rather than left as a literal in a dozen
components.

## Recorded divergences

Things where the code deliberately does not match the file. Each is a decision,
not a gap; changing one back is a design conversation, not a bugfix.

| Where | The file | The code | Why |
| --- | --- | --- | --- |
| Thread header bot mark | A different fill from the same bot's rail mark | The bot's own mark, at 18px | One bot, one face. Two marks for one bot reads as a drawing inconsistency, not as hierarchy. |
| New-bot tone picker, selected state | 2px border in the text-primary colour | A 2px ring with a surface-coloured offset | The file's own treatment is invisible on tone 1 — a near-white border on a near-white swatch — and tone 1 is the default selection. |
| Tone swatches | Literal hexes for swatches 4–6 | The same tokens `BotMark` fills with | The file's swatch hexes do not match its own mark fills. A swatch that lies about the result is worse than a swatch that is 2% off the drawing. |
| `BrandTile` icon size | Hand-tuned 19–22px per brand inside a 34px plate | `round(size × 0.575)` for every brand | A 15-entry lookup table for ≤2px, with no rule behind the numbers. Revisit if a specific mark reads wrong. |
| Launch tagline width | `width: 560px` | `w-[620px]` | 560px fits the artboard's system font on one line. Geist is wider, and Geist is the product's font. Keeping the number would orphan "work to." onto a second line — the design's intent is one line, and that is what was ported. |
| Plugin row | Name + blurb | Name + blurb | Matches, after removing a "Each member signs in with their own account" line this codebase had added. It was true of nearly every row, and a line that appears on almost every row is not information. The sentence lives on the authorization card, where someone is actually about to hand over an account. |
| Traffic lights | Always drawn | Rendered only inside the Electron shell | The browser has no window to close. Fake window controls are a lie the file cannot tell, because a Paper artboard is always the desktop app. |

## When you change a component

1. Pull the node's JSX again. The file may have moved.
2. Change the component, not the call site. A `[&_svg]:size-4` reaching into a
   component's internals is a dependency nothing checks — add the prop.
3. Screenshot the Paper artboard and read your rendered output beside it.
4. If you diverge on purpose, add a row to the table above in the same change.
