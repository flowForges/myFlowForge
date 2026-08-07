#!/usr/bin/env python3
"""Create compact QA contact sheets and 88px animated stage previews."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

CELL = 120
PREVIEW = 88


def _checkerboard(width: int, height: int, tile: int = 11) -> Image.Image:
    image = Image.new("RGBA", (width, height), (232, 232, 228, 255))
    draw = ImageDraw.Draw(image)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if (x // tile + y // tile) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=(74, 78, 86, 255))
    return image


def make_previews(pack_dir: Path, contact_path: Path, gif_path: Path) -> None:
    manifest = json.loads((pack_dir / "pet.json").read_text(encoding="utf-8"))
    stages = manifest["stages"]
    action_rows = [manifest["actions"][name]["row"] for name in ("idle", "working", "alert")]
    contact = _checkerboard(len(stages) * PREVIEW, len(action_rows) * PREVIEW)
    gif_frames: list[Image.Image] = []

    for stage_index, stage in enumerate(stages):
        with Image.open(pack_dir / stage["sheet"]) as atlas:
            rgba = atlas.convert("RGBA")
            for action_index, row in enumerate(action_rows):
                cell = rgba.crop((0, row * CELL, CELL, row * CELL + CELL))
                cell = cell.resize((PREVIEW, PREVIEW), Image.Resampling.LANCZOS)
                contact.alpha_composite(cell, (stage_index * PREVIEW, action_index * PREVIEW))
            for col in range(manifest["atlas"]["cols"]):
                cell = rgba.crop((col * CELL, 0, col * CELL + CELL, CELL))
                cell = cell.resize((PREVIEW, PREVIEW), Image.Resampling.LANCZOS)
                background = _checkerboard(PREVIEW, PREVIEW)
                background.alpha_composite(cell)
                gif_frames.append(background.convert("P", palette=Image.Palette.ADAPTIVE))

    contact_path.parent.mkdir(parents=True, exist_ok=True)
    contact.save(contact_path, "PNG", optimize=True)
    gif_frames[0].save(
        gif_path,
        "GIF",
        save_all=True,
        append_images=gif_frames[1:],
        duration=140,
        loop=0,
        disposal=2,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pack_dir", type=Path)
    parser.add_argument("contact_path", type=Path)
    parser.add_argument("gif_path", type=Path)
    args = parser.parse_args()
    make_previews(args.pack_dir, args.contact_path, args.gif_path)


if __name__ == "__main__":
    main()
