// ESLint flat config — the repo's JS style gate (`npm run lint`, run first by `npm test` and CI).
// Rules: eslint's `recommended` set, plus the handful below that encode this codebase's own
// conventions (4-space indent, double quotes, semicolons, no `var`). Source files are browser ES
// modules; tests and build.mjs run under node.
import js from "@eslint/js";
import globals from "globals";

export default [
    js.configs.recommended,
    { ignores: ["dist/", "node_modules/", "viewer_out/", "group-viewer-out/", "store/", ".venv/"] },
    {
        files: ["**/*.js", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.browser, ...globals.node },
        },
        rules: {
            // Blocks step by 4. Continuation lines of a wrapped call/array/object/parameter list
            // are left to the author (the codebase aligns matrices and long literals visually),
            // and comment columns are free.
            "indent": ["error", 4, {
                SwitchCase: 1, ignoreComments: true,
                ArrayExpression: "off", ObjectExpression: "off", CallExpression: { arguments: "off" },
                FunctionDeclaration: { parameters: "off" }, FunctionExpression: { parameters: "off" },
            }],
            "quotes": ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
            "semi": ["error", "always"],
            "no-var": "error",
            "prefer-const": "error",
            "eqeqeq": ["error", "always", { null: "ignore" }],
            // `_x` names mark deliberately-unused parameters (the adapter contract's stubs).
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
        },
    },
];
