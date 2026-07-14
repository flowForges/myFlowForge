# Asset build scripts

`build-animated-pet-pack.py` combines each pet state's original 4×2 keyframe sheet from `source/` with the matching 4×2 one-third and two-thirds sheets from `inbetweens/`. It cleans and strictly interleaves those inputs into 24 independent frames, then emits GIF, WebP, APNG, and PNG outputs without repeating keyframes.

The builder requires Pillow and Codex's image-generation skill because it calls `remove_chroma_key.py` from `$CODEX_HOME/skills/.system/imagegen/scripts/`. Border sampling handles both green and magenta chroma keys. Generated assets are committed, so installing this build-only tooling is not required to run or package the app. Run `validate-pet-motion.py`, `validate-pet-alpha.py`, and `validate-pet-pack.cjs` after rebuilding a pack.
