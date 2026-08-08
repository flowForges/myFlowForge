from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

ROW_SIZE = (720, 120)
ATLAS_SIZE = (720, 360)


def assemble_character_atlas(
    idle_path: Path,
    working_path: Path,
    alert_path: Path,
    output_path: Path,
) -> None:
    rows: list[Image.Image] = []
    for path in (idle_path, working_path, alert_path):
        with Image.open(path) as source:
            row = source.convert("RGBA")
        if row.size != ROW_SIZE:
            raise ValueError(f"character row must be 720x120, got {row.width}x{row.height}: {path}")
        rows.append(row)

    atlas = Image.new("RGBA", ATLAS_SIZE, (0, 0, 0, 0))
    for index, row in enumerate(rows):
        atlas.alpha_composite(row, (0, index * ROW_SIZE[1]))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(output_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Stack idle, working, and alert rows into a 720x360 atlas.")
    parser.add_argument("idle_path", type=Path)
    parser.add_argument("working_path", type=Path)
    parser.add_argument("alert_path", type=Path)
    parser.add_argument("output_path", type=Path)
    arguments = parser.parse_args()
    assemble_character_atlas(
        arguments.idle_path,
        arguments.working_path,
        arguments.alert_path,
        arguments.output_path,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
