#!/usr/bin/env python3
"""Contract tests for the 24-frame pet-pack builder."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

from PIL import Image


SCRIPT = Path(__file__).with_name("build-animated-pet-pack.py")
SPEC = importlib.util.spec_from_file_location("pet_pack_builder", SCRIPT)
assert SPEC and SPEC.loader
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BuildAnimatedPetPackTest(unittest.TestCase):
    def test_state_loops_use_a_calm_readable_cadence(self) -> None:
        self.assertEqual(
            BUILDER.STATES,
            {
                "idle": (24, 3200),
                "working": (24, 2400),
                "confirm": (24, 2400),
                "input": (24, 2400),
                "done": (24, 2600),
            },
        )

    def test_every_state_encodes_exactly_24_frames(self) -> None:
        self.assertEqual(
            {state: frame_count for state, (frame_count, _) in BUILDER.STATES.items()},
            {state: 24 for state in ("idle", "working", "confirm", "input", "done")},
        )

    def test_crops_each_input_sheet_as_four_columns_by_two_rows(self) -> None:
        sheet = Image.new("RGB", (400, 200))
        for index in range(8):
            col, row = index % 4, index // 4
            color = (index, 255 - index, index * 3)
            for y in range(row * 100, (row + 1) * 100):
                for x in range(col * 100, (col + 1) * 100):
                    sheet.putpixel((x, y), color)

        cells = BUILDER.crop_sheet_cells(sheet)

        self.assertEqual(len(cells), 8)
        self.assertEqual([cell.getpixel((50, 50))[0] for cell in cells], list(range(8)))

    def test_state_inputs_use_original_keys_and_two_inbetween_sheets(self) -> None:
        pack = Path("/tmp/example-pack")
        self.assertEqual(
            BUILDER.input_sheet_paths(pack, "idle"),
            (
                pack / "source" / "idle-sheet.png",
                pack / "inbetweens" / "idle-one-third-sheet.png",
                pack / "inbetweens" / "idle-two-thirds-sheet.png",
            ),
        )

    def test_interleaves_key_one_third_and_two_thirds_frames(self) -> None:
        keys = [Image.new("RGBA", (1, 1), (index, 0, 0, 255)) for index in range(8)]
        one_thirds = [Image.new("RGBA", (1, 1), (100 + index, 0, 0, 255)) for index in range(8)]
        two_thirds = [Image.new("RGBA", (1, 1), (200 + index, 0, 0, 255)) for index in range(8)]

        output = BUILDER.interleave_frames(keys, one_thirds, two_thirds)

        self.assertEqual(len(output), 24)
        self.assertEqual(
            [frame.getpixel((0, 0))[0] for frame in output],
            [value for index in range(8) for value in (index, 100 + index, 200 + index)],
        )

    def test_rejects_incomplete_input_sheet_frames(self) -> None:
        frames = [Image.new("RGBA", (1, 1)) for _ in range(8)]
        with self.assertRaisesRegex(ValueError, "exactly 8"):
            BUILDER.interleave_frames(frames[:-1], frames, frames)


if __name__ == "__main__":
    unittest.main()
