import { config } from "@evie/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [...config, { ignores: ["out/**"] }];
