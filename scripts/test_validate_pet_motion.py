#!/usr/bin/env python3
"""Tests for the strict 24-frame pet motion asset contract."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


SCRIPT = Path(__file__).with_name("validate-pet-motion.py")
STATES = ("idle", "working", "confirm", "input", "done")
STATE_DURATIONS = {
    "idle": 3200,
    "working": 2400,
    "confirm": 2400,
    "input": 2400,
    "done": 2600,
}


def make_frame(
    index: int,
    *,
    size: tuple[int, int] = (256, 256),
    touches_margin: bool = False,
    opaque_corner: bool = False,
) -> Image.Image:
    image = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    left = 7 if touches_margin else 16 + index
    draw.rectangle((left, 48, left + 40, 88), fill=(index * 7, 80, 220, 255))
    if opaque_corner:
        image.putpixel((0, 0), (255, 0, 0, 255))
    return image


def state_frame_durations(state: str) -> list[int]:
    quotient, remainder = divmod(STATE_DURATIONS[state], 24)
    return [quotient + (index < remainder) for index in range(24)]


def write_webp(
    path: Path,
    frames: list[Image.Image],
    *,
    duration: int | list[int],
    loop: int = 0,
) -> None:
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=loop,
        lossless=True,
    )


def write_pack(root: Path) -> None:
    for state in STATES:
        frame_dir = root / "frames" / state
        frame_dir.mkdir(parents=True)
        frames = [make_frame(index) for index in range(24)]
        for index, frame in enumerate(frames):
            frame.save(frame_dir / f"{index:02d}.png")
        webp_dir = root / "webp"
        webp_dir.mkdir(parents=True, exist_ok=True)
        write_webp(
            webp_dir / f"{state}.webp",
            frames,
            duration=state_frame_durations(state),
        )


class ValidatePetMotionTest(unittest.TestCase):
    def run_validator(self, *roots: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *(str(root) for root in roots)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_accepts_multiple_complete_packs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first"
            second = Path(directory) / "second"
            write_pack(first)
            write_pack(second)

            result = self.run_validator(first, second)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("validated 2 pet packs", result.stdout)

    def test_rejects_a_state_without_exactly_24_png_frames(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            (root / "frames" / "idle" / "23.png").unlink()

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("idle: expected 24 PNG frames, found 23", result.stderr)

    def test_rejects_duplicate_png_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            duplicate = root / "frames" / "working" / "01.png"
            duplicate.write_bytes((root / "frames" / "working" / "00.png").read_bytes())

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("working: expected 24 pixel-unique PNG frames, found 23", result.stderr)

    def test_ignores_hidden_rgb_when_hashing_transparent_png_pixels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            original = Image.open(root / "frames" / "working" / "00.png").convert("RGBA")
            original.putpixel((255, 255), (255, 17, 99, 0))
            original.save(root / "frames" / "working" / "01.png")

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("working: expected 24 pixel-unique PNG frames, found 23", result.stderr)

    def test_rejects_source_frame_inside_the_eight_pixel_margin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            make_frame(0, touches_margin=True).save(root / "frames" / "confirm" / "00.png")

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("confirm/00.png: opaque bbox violates 8px safety margin", result.stderr)

    def test_rejects_an_opaque_source_frame_corner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            make_frame(0, opaque_corner=True).save(root / "frames" / "confirm" / "00.png")

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("corners must be transparent", result.stderr)

    def test_rejects_webp_without_24_decoded_frames(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            frames = [make_frame(index) for index in range(23)]
            frames[0].save(
                root / "webp" / "done.webp",
                save_all=True,
                append_images=frames[1:],
                duration=60,
                loop=0,
                lossless=True,
            )

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("done.webp: expected 24 decoded frames, found 23", result.stderr)

    def test_rejects_webp_without_a_256_pixel_canvas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            frames = [make_frame(index, size=(255, 256)) for index in range(24)]
            write_webp(
                root / "webp" / "idle.webp",
                frames,
                duration=state_frame_durations("idle"),
            )

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "idle.webp: expected 256x256 canvas, found 255x256", result.stderr
            )

    def test_rejects_webp_that_does_not_loop_forever(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            frames = [make_frame(index) for index in range(24)]
            write_webp(
                root / "webp" / "confirm.webp",
                frames,
                duration=state_frame_durations("confirm"),
                loop=1,
            )

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "confirm.webp: expected infinite loop (loop=0), found loop=1",
                result.stderr,
            )

    def test_rejects_webp_with_the_wrong_total_duration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            frames = [make_frame(index) for index in range(24)]
            write_webp(
                root / "webp" / "input.webp",
                frames,
                duration=50,
            )

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn(
                "input.webp: expected total duration 2400ms, found 1200ms",
                result.stderr,
            )

    def test_rejects_24_webp_frames_with_only_23_unique_images(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_pack(root)
            frames = [make_frame(index) for index in range(23)] + [make_frame(0)]
            frames[0].save(
                root / "webp" / "done.webp",
                save_all=True,
                append_images=frames[1:],
                duration=60,
                loop=0,
                lossless=True,
            )

            with Image.open(root / "webp" / "done.webp") as image:
                self.assertEqual(image.n_frames, 24)

            result = self.run_validator(root)

            self.assertEqual(result.returncode, 1)
            self.assertNotIn("expected 24 decoded frames", result.stderr)
            self.assertIn(
                "done.webp: expected 24 pixel-unique decoded frames, found 23",
                result.stderr,
            )


if __name__ == "__main__":
    unittest.main()
