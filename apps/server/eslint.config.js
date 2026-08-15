import globals from "globals";
import { config } from "@evie/eslint-config/base";

/**
 * `scripts/` is plain Node, not TypeScript, so `no-undef` is live there and the
 * shared browser-shaped config reports `console` and `process` as undefined.
 * The `src` tree needs nothing: typescript-eslint turns `no-undef` off for the
 * files the compiler already checks.
 */
/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  { files: ["scripts/**"], languageOptions: { globals: { ...globals.node } } },
];
