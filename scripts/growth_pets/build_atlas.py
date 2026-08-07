#!/usr/bin/env python3
"""Build a 6x3 growth-pet atlas from one transparent source render."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

COLS = 6
CELL = 120
ROWS = 3
CANVAS_SIZE = (COLS * CELL, ROWS * CELL)

MOTIONS = (
    # scale, angle, lift
    ((1.00, -1, 0), (1.01, 0, 1), (1.02, 1, 2), (1.01, 0, 1), (1.00, -1, 0), (0.99, 0, 0)),
    ((0.98, -6, 2), (1.01, 6, 3), (0.99, -7, 2), (1.01, 7, 3), (0.99, -5, 2), (1.01, 5, 1)),
    ((1.03, -8, 4), (1.02, 8, 2), (1.03, -8, 4), (1.02, 8, 2), (1.03, -7, 4), (1.02, 7, 2)),
)


def _trim_and_fit(source: Image.Image, max_width: int = 92, max_height: int = 92) -> Image.Image:
    rgba = source.convert("RGBA")
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("source image is fully transparent")
    cropped = rgba.crop(bbox)
    ratio = min(max_width / cropped.width, max_height / cropped.height)
    size = (max(1, round(cropped.width * ratio)), max(1, round(cropped.height * ratio)))
    return cropped.resize(size, Image.Resampling.LANCZOS)


def _frame(base: Image.Image, scale: float, angle: float) -> Image.Image:
    size = (max(1, round(base.width * scale)), max(1, round(base.height * scale)))
    scaled = base.resize(size, Image.Resampling.LANCZOS)
    return scaled.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)


def build_atlas(source_path: Path, output_path: Path) -> None:
    with Image.open(source_path) as source:
        base = _trim_and_fit(source)

    atlas = Image.new("RGBA", CANVAS_SIZE, (0, 0, 0, 0))
    baseline = CELL - 5
    for row, motion in enumerate(MOTIONS):
        for col, (scale, angle, lift) in enumerate(motion):
            frame = _frame(base, scale, angle)
            x = col * CELL + (CELL - frame.width) // 2
            y = row * CELL + baseline - frame.height - lift
            atlas.alpha_composite(frame, (x, y))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    build_atlas(args.source, args.output)


if __name__ == "__main__":
    main()
