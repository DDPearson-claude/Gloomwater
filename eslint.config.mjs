// One rule only: every identifier the game reads must be declared somewhere.
// This catches hand-patch typos (such as `tt` for `Te`) without opening a browser,
// including in code paths the smoke test never reaches.
import globals from "globals";

export default [
  {
    files: ["src/game.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, __THREE_DEVTOOLS__: "readonly" },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: { "no-undef": "error" },
  },
];
