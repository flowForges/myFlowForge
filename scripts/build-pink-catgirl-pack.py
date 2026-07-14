#!/usr/bin/env python3
"""Build pink-catgirl from its original keys and authored inbetween sheets."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    builder = Path(__file__).with_name("build-animated-pet-pack.py")
    pack = root / "assets" / "pet-packs" / "pink-catgirl"
    raise SystemExit(subprocess.call([sys.executable, str(builder), str(pack)]))


if __name__ == "__main__":
    main()
