import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // This app fetches all its data client-side via useEffect + setState
      // (no Suspense/RSC data loading, no query library) and syncs localStorage
      // on mount the same way — that's the whole app's data-loading pattern,
      // not a bug. Downgraded to a warning rather than left as a permanently
      // red, ignored error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
