# `@evie/eslint-config`

Shared ESLint configuration for the Evie workspace.

| Export             | Use it for                                                         |
| ------------------ | ------------------------------------------------------------------ |
| `./base`           | Any package. TypeScript, prettier, `turbo/no-undeclared-env-vars`. |
| `./react-internal` | Packages that ship React components (`@evie/ui`, `apps/web`).      |

Consume it from a package's `eslint.config.js`:

```js
import { config } from "@evie/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default config;
```
