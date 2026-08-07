from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from scripts.growth_pets.build_atlas import build_atlas
from scripts.growth_pets.validate_growth_pack import validate_pack


class GrowthPetToolsTest(unittest.TestCase):
    def test_build_atlas_has_exact_geometry_alpha_and_motion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            output = root / "atlas.png"
            image = Image.new("RGBA", (80, 100), (0, 0, 0, 0))
            for x in range(20, 60):
                for y in range(10, 95):
                    image.putpixel((x, y), (120, 80, 40, 255))
            image.save(source)
            build_atlas(source, output)
            with Image.open(output) as atlas:
                self.assertEqual(atlas.size, (720, 360))
                self.assertEqual(atlas.mode, "RGBA")
                self.assertEqual(atlas.getpixel((0, 0))[3], 0)
                idle = atlas.crop((0, 0, 120, 120))
                working = atlas.crop((0, 120, 120, 240))
                alert = atlas.crop((0, 240, 120, 360))
                self.assertNotEqual(idle.tobytes(), working.tobytes())
                self.assertNotEqual(working.tobytes(), alert.tobytes())

    def test_strict_validator_accepts_valid_pack_and_rejects_bad_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atlas = Image.new("RGBA", (720, 360), (0, 0, 0, 0))
            for row in range(3):
                for col in range(6):
                    for x in range(col * 120 + 20, col * 120 + 100):
                        for y in range(row * 120 + 20, row * 120 + 100):
                            atlas.putpixel((x, y), (80, 120, 160, 255))
            atlas.save(root / "stage.png")
            manifest = {
                "id": "test-growth",
                "name": "Test",
                "kind": "growth",
                "signal": "dailyTokens",
                "atlas": {"cols": 6, "cellW": 120, "cellH": 120},
                "actions": {
                    "idle": {"row": 0, "durations": [1]},
                    "working": {"row": 1, "durations": [1]},
                    "alert": {"row": 2, "durations": [1]},
                },
                "stages": [{"at": 0, "sheet": "stage.png"}],
            }
            (root / "pet.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertEqual(validate_pack(root), [])
            manifest["stages"][0]["sheet"] = "../stage.png"
            (root / "pet.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertTrue(any("safe relative path" in error for error in validate_pack(root)))

    def test_validator_rejects_duplicate_rows_and_wrong_geometry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGB", (100, 100), "white").save(root / "bad.png")
            manifest = {
                "id": "bad-growth",
                "name": "Bad",
                "kind": "growth",
                "signal": "dailyTokens",
                "atlas": {"cols": 6, "cellW": 120, "cellH": 120},
                "actions": {
                    "idle": {"row": 0, "durations": [1]},
                    "working": {"row": 0, "durations": [1]},
                },
                "stages": [{"at": 0, "sheet": "bad.png"}],
            }
            (root / "pet.json").write_text(json.dumps(manifest), encoding="utf-8")
            errors = validate_pack(root)
            self.assertTrue(any("rows must be unique" in error for error in errors))
            self.assertTrue(any("expected 720x240" in error for error in errors))
            self.assertTrue(any("alpha channel" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
