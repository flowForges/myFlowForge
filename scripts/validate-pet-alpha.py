#!/usr/bin/env python3
"""Fail when an animated pet frame has an opaque canvas corner."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


def validate(path: Path) -> list[str]:
    failures = []
    image = Image.open(path)
    for frame_index in range(getattr(image, "n_frames", 1)):
        image.seek(frame_index)
        rgba = image.convert("RGBA")
        corners = (
            rgba.getpixel((0, 0))[3],
            rgba.getpixel((rgba.width - 1, 0))[3],
            rgba.getpixel((0, rgba.height - 1))[3],
            rgba.getpixel((rgba.width - 1, rgba.height - 1))[3],
        )
        if any(alpha != 0 for alpha in corners):
            failures.append(f"{path}: frame {frame_index} corner alpha {corners}")
    return failures


def main() -> None:
    root = Path(sys.argv[1])
    files = sorted(root.glob("*.gif")) + sorted((root / "webp").glob("*.webp")) + sorted((root / "apng").glob("*.png"))
    failures = [failure for path in files for failure in validate(path)]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        raise SystemExit(1)
    print(f"validated transparent corners in {len(files)} animations")


if __name__ == "__main__":
    main()
