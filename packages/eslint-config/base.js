import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import tseslint from "typescript-eslint";

/**
 * A shared ESLint configuration for the repository.
 *
 * Severities mean what they say: an error fails `turbo run lint` wherever it
 * runs. A rule left at "warn" stays advisory in the local loop and still blocks
 * CI, which runs the same lint with `--max-warnings 0` -- root `lint:ci`, the
 * one command that reproduces the merge gate. `eslint-plugin-only-warn` used to
 * sit here and downgrade every rule to a warning, which is why lint could not
 * fail; do not put it back.
 *
 * @type {import("eslint").Linter.Config[]}
 * */
export const config = [
  js.configs.recommended,
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    plugins: {
      turbo: turboPlugin,
    },
    rules: {
      "turbo/no-undeclared-env-vars": "warn",
    },
  },
  {
    ignores: ["dist/**"],
  },
];
