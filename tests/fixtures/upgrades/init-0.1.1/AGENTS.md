<!-- block-beaver:start -->
## Block Beaver

Read and follow the project workflow at .blocks/WORKFLOW.md before changing code.
- Read the existing block registry and fresh source graph; define the feature's files, interfaces, dependencies, and checks before implementing it.
- Keep block manifests aligned with implementation and use the bounded plan/propose/check/review workflow. Existing project registries remain authoritative.
- After source or manifest changes, run `block-beaver update --root .` to regenerate .blocks/view/index.html and graph.json. Do not hand-edit generated views.
- Run `block-beaver start --root .` for a live map that refreshes during development. Report block changes and verification at completion.
<!-- block-beaver:end -->
