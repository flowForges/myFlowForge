#!/usr/bin/env python3
"""Build stage-aware tree atlases with a fixed soil platform."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw

from scripts.growth_pets.build_atlas import CELL, COLS, ROWS, _trim_and_fit

SUN_POSITIONS = {2: (95, 14), 3: (60, 14), 4: (25, 14)}


def _normalized_cell(source: Image.Image) -> Image.Image:
    fitted = _trim_and_fit(source)
    cell = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    cell.alpha_composite(fitted, ((CELL - fitted.width) // 2, CELL - 5 - fitted.height))
    return cell


def _masked_part(cell: Image.Image, predicate) -> Image.Image:
    part = Image.new("RGBA", cell.size, (0, 0, 0, 0))
    source = cell.load()
    target = part.load()
    for y in range(cell.height):
        for x in range(cell.width):
            if predicate(x, y) and source[x, y][3]:
                target[x, y] = source[x, y]
    return part


def _clear_parts(cell: Image.Image, parts: tuple[Image.Image, ...]) -> Image.Image:
    static = cell.copy()
    alpha = static.getchannel("A")
    alpha_pixels = alpha.load()
    masks = [part.getchannel("A").load() for part in parts]
    for y in range(cell.height):
        for x in range(cell.width):
            if any(mask[x, y] for mask in masks):
                alpha_pixels[x, y] = 0
    static.putalpha(alpha)
    return static


def _shift(part: Image.Image, dx: int, dy: int) -> Image.Image:
    shifted = Image.new("RGBA", part.size, (0, 0, 0, 0))
    shifted.alpha_composite(part, (dx, dy))
    return shifted


def _young_frame(base: Image.Image, stage: int, row: int, frame: int) -> Image.Image:
    moving_ceiling = 72 if stage == 0 else 78
    left = _masked_part(base, lambda x, y: y < moving_ceiling and x < 57)
    right = _masked_part(base, lambda x, y: y < moving_ceiling and x > 63)
    static = _clear_parts(base, (left, right))

    idle = ((0, 0), (0, -1), (0, -2), (0, -1), (0, 0), (0, 1))
    if stage == 0:
        working = ((0, -3), (0, 3), (0, -4), (0, 4), (0, -3), (0, 3))
        alert = ((0, -5), (0, 5), (0, -6), (0, 6), (0, -5), (0, 5))
    else:
        working = ((-2, -3), (2, 3), (-2, -4), (2, 4), (-2, -3), (2, 3))
        alert = ((-3, -5), (3, 5), (-3, -6), (3, 6), (-3, -5), (3, 5))
    dx, dy = (idle, working, alert)[row][frame]

    result = static.copy()
    result.alpha_composite(_shift(left, dx, dy))
    result.alpha_composite(_shift(right, -dx, -dy))
    return result


def _draw_sun(cell: Image.Image, center: tuple[int, int], frame: int, alert: bool) -> None:
    draw = ImageDraw.Draw(cell)
    pulse = (0, 1, 2, 1, 0, 1)[frame]
    radius = (6 if not alert else 7) + pulse
    ray_end = radius + (3 if not alert else 4)
    ray_width = 2 if not alert else 3
    color = (255, 184 + (frame % 2) * 16, 42, 255)
    cx, cy = center
    for angle in range(0, 360, 45):
        radians = math.radians(angle)
        start = (round(cx + radius * math.cos(radians)), round(cy + radius * math.sin(radians)))
        end = (round(cx + ray_end * math.cos(radians)), round(cy + ray_end * math.sin(radians)))
        draw.line((start, end), fill=color, width=ray_width)
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color, outline=(218, 126, 20, 255), width=1)


def _draw_wind_and_leaves(cell: Image.Image, frame: int, alert: bool) -> None:
    draw = ImageDraw.Draw(cell)
    wind = (196, 222, 226, 230)
    shift = (0, 2, 4, 6, 4, 2)[frame]
    draw.arc((4 + shift, 18, 48 + shift, 34), 190, 350, fill=wind, width=2)
    draw.arc((12 - shift // 2, 34, 60 - shift // 2, 50), 190, 350, fill=wind, width=2)
    if alert:
        draw.arc((54 - shift, 10, 108 - shift, 28), 190, 350, fill=wind, width=3)

    paths = [
        ((22, 40), (4, 3), (218, 118, 35, 255)),
        ((92, 55), (-5, 4), (242, 156, 42, 255)),
        ((70, 28), (-3, 5), (181, 83, 28, 255)),
        ((36, 65), (5, 2), (231, 139, 34, 255)),
        ((55, 48), (4, 4), (205, 96, 31, 255)),
    ]
    count = 5 if alert else 3
    for index, (origin, velocity, color) in enumerate(paths[:count]):
        x = origin[0] + velocity[0] * frame
        y = origin[1] + velocity[1] * frame
        x = 8 + (x - 8) % 104
        y = 12 + (y - 12) % 68
        radius = 4 if alert else 3
        draw.ellipse((x - radius, y - 2, x + radius, y + 2), fill=color, outline=(125, 65, 25, 255), width=1)


def build_tree_atlas(source_path: Path, output_path: Path, stage: int) -> None:
    if stage not in range(6):
        raise ValueError("stage must be between 0 and 5")
    with Image.open(source_path) as source:
        base = _normalized_cell(source.convert("RGBA"))

    atlas = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    for row in range(ROWS):
        for frame in range(COLS):
            if stage in (0, 1):
                cell = _young_frame(base, stage, row, frame)
            else:
                cell = base.copy()
                if stage in SUN_POSITIONS and row > 0:
                    _draw_sun(cell, SUN_POSITIONS[stage], frame, alert=row == 2)
                elif stage == 5 and row > 0:
                    _draw_wind_and_leaves(cell, frame, alert=row == 2)
            atlas.alpha_composite(cell, (frame * CELL, row * CELL))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path, "PNG", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("stage", type=int)
    args = parser.parse_args()
    build_tree_atlas(args.source, args.output, args.stage)


if __name__ == "__main__":
    main()
