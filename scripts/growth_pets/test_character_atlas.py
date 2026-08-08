from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from PIL import Image

from scripts.growth_pets.assemble_character_atlas import assemble_character_atlas


class CharacterAtlasAssemblerTest(unittest.TestCase):
    def test_stacks_idle_working_and_alert_rows_in_contract_order(self) -> None:
        colors = [(180, 40, 40, 255), (40, 180, 40, 255), (40, 40, 180, 255)]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = []
            for index, color in enumerate(colors):
                path = root / f"row-{index}.png"
                Image.new("RGBA", (720, 120), color).save(path)
                paths.append(path)
            output = root / "atlas.png"

            assemble_character_atlas(paths[0], paths[1], paths[2], output)

            with Image.open(output) as image:
                atlas = image.convert("RGBA")
            self.assertEqual(atlas.size, (720, 360))
            self.assertEqual(atlas.getpixel((10, 10)), colors[0])
            self.assertEqual(atlas.getpixel((10, 130)), colors[1])
            self.assertEqual(atlas.getpixel((10, 250)), colors[2])

    def test_rejects_a_row_with_wrong_dimensions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / "valid.png"
            invalid = root / "invalid.png"
            Image.new("RGBA", (720, 120)).save(valid)
            Image.new("RGBA", (719, 120)).save(invalid)

            with self.assertRaisesRegex(ValueError, "720x120"):
                assemble_character_atlas(valid, invalid, valid, root / "atlas.png")


if __name__ == "__main__":
    unittest.main()
