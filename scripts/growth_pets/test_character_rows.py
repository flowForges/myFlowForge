from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

from scripts.growth_pets.assemble_character_rows import assemble_character_row


PYTHON = Path("/Users/you/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3")
CELL_SIZE = 120
ROW_SIZE = (CELL_SIZE * 6, CELL_SIZE)
CHROMA = (12, 250, 24, 255)
BODY = (120, 70, 40, 255)
ACCENT = (220, 180, 80, 255)
SHOE = (15, 15, 15, 255)


def _pose_source(path: Path, widths: list[int], heights: list[int]) -> None:
    image = Image.new("RGBA", (900, 200), CHROMA)
    draw = ImageDraw.Draw(image)
    left = 30
    for index, (width, height) in enumerate(zip(widths, heights, strict=True)):
        foot_y = 170 - (index % 2) * 4
        right = left + width
        top = foot_y - height
        draw.rounded_rectangle((left + 6, top, right - 6, foot_y - 14), radius=8, fill=BODY)
        draw.ellipse((left + width * 0.25, top - 18, left + width * 0.75, top + 18), fill=ACCENT)
        draw.rectangle((left + 10, foot_y - 14, right - 10, foot_y), fill=SHOE)
        left += width + 26
    image.save(path)


def _alpha_bounds(image: Image.Image) -> tuple[int, int, int, int] | None:
    left = image.width
    top = image.height
    right = -1
    bottom = -1
    for y in range(image.height):
        for x in range(image.width):
            if image.getpixel((x, y))[3]:
                left = min(left, x)
                top = min(top, y)
                right = max(right, x)
                bottom = max(bottom, y)
    if right < 0:
        return None
    return (left, top, right, bottom)


def _opaque_bottom(image: Image.Image) -> int:
    bottom = -1
    for y in range(image.height):
        for x in range(image.width):
            if image.getpixel((x, y))[3]:
                bottom = max(bottom, y)
    return bottom


def _component_heights(image: Image.Image) -> list[int]:
    bounds: list[tuple[int, int, int, int]] = []
    width, height = image.size
    visited = [[False] * width for _ in range(height)]
    for y in range(height):
        for x in range(width):
            if visited[y][x]:
                continue
            visited[y][x] = True
            if image.getpixel((x, y)) == CHROMA:
                continue
            stack = [(x, y)]
            left = right = x
            top = bottom = y
            while stack:
                current_x, current_y = stack.pop()
                left = min(left, current_x)
                right = max(right, current_x)
                top = min(top, current_y)
                bottom = max(bottom, current_y)
                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if not (0 <= next_x < width and 0 <= next_y < height):
                        continue
                    if visited[next_y][next_x]:
                        continue
                    visited[next_y][next_x] = True
                    if image.getpixel((next_x, next_y)) != CHROMA:
                        stack.append((next_x, next_y))
            bounds.append((left, top, right, bottom))
    return [bottom - top + 1 for _, top, _, bottom in sorted(bounds)]


class CharacterRowAssemblerTest(unittest.TestCase):
    def test_assemble_character_row_removes_chroma_and_aligns_cells(self) -> None:
        widths = [38, 42, 46, 50, 54, 58]
        heights = [92, 84, 76, 68, 60, 52]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "poses.png"
            output = root / "row.png"
            _pose_source(source, widths, heights)
            with Image.open(source) as source_image:
                source_heights = _component_heights(source_image.convert("RGBA"))

            assemble_character_row(source, output)

            with Image.open(output) as image:
                row = image.convert("RGBA")

            self.assertEqual(row.size, ROW_SIZE)
            self.assertEqual(row.mode, "RGBA")
            self.assertEqual(row.getpixel((0, 0))[3], 0)

            bottoms: list[int] = []
            rendered_heights: list[int] = []
            for index in range(6):
                cell = row.crop((index * CELL_SIZE, 0, (index + 1) * CELL_SIZE, CELL_SIZE))
                bounds = _alpha_bounds(cell)
                self.assertIsNotNone(bounds, f"cell {index} should not be empty")
                left, top, right, bottom = bounds or (0, 0, 0, 0)
                self.assertGreater(left, 0, f"cell {index} should keep left margin")
                self.assertLess(right, CELL_SIZE - 1, f"cell {index} should keep right margin")
                self.assertGreater(top, 0, f"cell {index} should keep top margin")
                self.assertLess(bottom, CELL_SIZE - 1, f"cell {index} should keep bottom margin")
                bottoms.append(_opaque_bottom(cell))
                rendered_heights.append(bottom - top + 1)

            self.assertTrue(all(bottom == bottoms[0] for bottom in bottoms[1:]))

            base_ratio = rendered_heights[0] / source_heights[0]
            for rendered_height, source_height in zip(rendered_heights[1:], source_heights[1:], strict=True):
                self.assertAlmostEqual(rendered_height / source_height, base_ratio, delta=0.06)

    def test_assemble_character_row_rejects_non_six_pose_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "five.png"
            output = root / "row.png"
            _pose_source(source, [40, 40, 40, 40, 40], [80, 76, 72, 68, 64])

            with self.assertRaisesRegex(ValueError, "6"):
                assemble_character_row(source, output)

    def test_cli_writes_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "poses.png"
            output = root / "row.png"
            _pose_source(source, [40, 42, 44, 46, 48, 50], [82, 80, 78, 76, 74, 72])

            result = subprocess.run(
                [str(PYTHON), "scripts/growth_pets/assemble_character_rows.py", str(source), str(output)],
                cwd=Path(__file__).resolve().parents[2],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists())
            with Image.open(output) as image:
                self.assertEqual(image.size, ROW_SIZE)


if __name__ == "__main__":
    unittest.main()
