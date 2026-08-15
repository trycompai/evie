import { config } from "@evie/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  // Written by @tanstack/router-plugin on every Vite start. Committed so a
  // typecheck works without running Vite, but it is not ours to lint.
  { ignores: ["src/routeTree.gen.ts"] },
];
