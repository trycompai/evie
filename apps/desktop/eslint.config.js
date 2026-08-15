import globals from "globals";
import { config } from "@evie/eslint-config/base";

/**
 * The main process and the preload are Node programs, not browser ones -- they
 * legitimately reach for `Buffer`, `process`, and `console`. Without this the
 * shared browser-shaped config reports every one of them as undefined.
 */
/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  { languageOptions: { globals: { ...globals.node } } },
  { ignores: ["out/**"] },
];
