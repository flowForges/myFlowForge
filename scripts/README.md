# Asset build scripts

`build-animated-pet-pack.py` converts a pet's five 4×2 source sheets into cleaned keyframes and GIF, WebP, APNG, and PNG outputs.

The builder requires Pillow and Codex's image-generation skill because it calls `remove_chroma_key.py` from `$CODEX_HOME/skills/.system/imagegen/scripts/`. Generated assets are committed, so installing this build-only tooling is not required to run or package the app. Run `validate-pet-alpha.py` and `validate-pet-pack.cjs` after rebuilding a pack.
