// eslint-config-next 16 ships a native flat config array, so it is spread
// directly. FlatCompat is not needed and in fact crashes against it.
import next from "eslint-config-next";

const config = [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      // Console noise in an operator tool hides the messages that matter.
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
];

export default config;

// Unused variables are caught by TypeScript itself (`noUnusedLocals` /
// `noUnusedParameters` in tsconfig.json), which runs as part of `next build`.
// Duplicating that as an ESLint rule would mean adding the typescript-eslint
// plugin to report errors the compiler already fails on.
