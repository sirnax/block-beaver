# Application ownership

Review `.blocks/config.json` and the graph's application areas. A file belongs to the deepest app whose tsconfig includes it; files outside apps remain visible. Imports resolve with the owning app's compiler options.

Use `block-beaver detect --root .` to preview newly detected apps and `block-beaver detect --write --root .` to add them. Owner-controlled entries use `"source": "config"`; do not replace them with detection output.

Inspect used-by chips, cross-app links, and the resolution report before changing shared files. Declare block dependencies and verify every affected app. `block-beaver scan --strict --root .` rejects configuration and resolution errors at the gate.
