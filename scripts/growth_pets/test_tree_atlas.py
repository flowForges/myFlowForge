from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


def _source(path: Path) -> None:
    image = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((70, 300, 330, 385), fill=(95, 58, 35, 255))
    draw.rectangle((194, 105, 206, 320), fill=(85, 90, 75, 255))
    draw.ellipse((80, 80, 198, 180), fill=(45, 150, 65, 255))
    draw.ellipse((202, 68, 330, 175), fill=(55, 165, 70, 255))
    image.save(path)


def _cells(atlas: Image.Image) -> list[Image.Image]:
    return [
        atlas.crop((col * 120, row * 120, col * 120 + 120, row * 120 + 120))
        for row in range(3)
        for col in range(6)
    ]


def _sun_centroid(cell: Image.Image) -> tuple[float, float, int]:
    points: list[tuple[int, int]] = []
    for y in range(cell.height):
        for x in range(cell.width):
            red, green, blue, alpha = cell.getpixel((x, y))
            if alpha and red > 250 and 175 < green < 225 and blue < 90:
                points.append((x, y))
    if not points:
        return (0, 0, 0)
    return (
        sum(point[0] for point in points) / len(points),
        sum(point[1] for point in points) / len(points),
        len(points),
    )


def _green_centroid_y(cell: Image.Image, left: bool) -> float:
    ys: list[int] = []
    for y in range(75):
        for x in range(120):
            red, green, blue, alpha = cell.getpixel((x, y))
            on_side = x < 58 if left else x > 62
            if on_side and alpha and green > red * 1.5 and green > blue * 1.3:
                ys.append(y)
    return sum(ys) / len(ys)


class TreeAtlasTest(unittest.TestCase):
    def _build(self, stage: int) -> Image.Image:
        try:
            from scripts.growth_pets.build_tree_atlas import build_tree_atlas
        except ImportError as exc:
            self.fail(f"tree-specific atlas builder is missing: {exc}")
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        source = root / "source.png"
        output = root / "atlas.png"
        _source(source)
        build_tree_atlas(source, output, stage)
        return Image.open(output).convert("RGBA")

    def test_soil_is_pixel_identical_in_every_frame(self) -> None:
        atlas = self._build(0)
        bottoms = [cell.crop((0, 88, 120, 120)).tobytes() for cell in _cells(atlas)]
        self.assertTrue(all(bottom == bottoms[0] for bottom in bottoms[1:]))

    def test_sprout_moves_leaves_without_moving_the_base(self) -> None:
        cells = _cells(self._build(0))
        self.assertNotEqual(cells[0].crop((0, 0, 120, 75)).tobytes(), cells[1].crop((0, 0, 120, 75)).tobytes())
        self.assertEqual(cells[0].crop((0, 75, 120, 120)).tobytes(), cells[1].crop((0, 75, 120, 120)).tobytes())
        self.assertGreater(abs(_green_centroid_y(cells[6], True) - _green_centroid_y(cells[0], True)), 1.8)
        self.assertGreater(abs(_green_centroid_y(cells[12], True) - _green_centroid_y(cells[0], True)), 3.2)

    def test_single_sun_uses_stage_specific_position(self) -> None:
        expected = {2: "right", 3: "center", 4: "left"}
        for stage, position in expected.items():
            cells = _cells(self._build(stage))
            self.assertEqual(_sun_centroid(cells[0])[2], 0, f"stage {stage} idle must not contain a sun")
            x, y, count = _sun_centroid(cells[6])
            self.assertGreater(count, 30)
            self.assertLess(y, 35)
            if position == "right":
                self.assertGreater(x, 82)
                self.assertLess(x, 102)
            elif position == "center":
                self.assertGreater(x, 55)
                self.assertLess(x, 65)
            else:
                self.assertGreater(x, 18)
                self.assertLess(x, 38)

    def test_autumn_uses_wind_and_leaves_without_a_sun(self) -> None:
        cells = _cells(self._build(5))
        self.assertEqual(_sun_centroid(cells[6])[2], 0)
        self.assertNotEqual(cells[0].tobytes(), cells[6].tobytes())
        self.assertNotEqual(cells[6].tobytes(), cells[12].tobytes())


if __name__ == "__main__":
    unittest.main()
