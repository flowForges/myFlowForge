#!/usr/bin/env python3
"""Validate that pet packs contain 24 real, safe motion frames per state."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from PIL import Image


STATES = ("idle", "working", "confirm", "input", "done")
STATE_DURATIONS = {
    "idle": 3200,
    "working": 2400,
    "confirm": 2400,
    "input": 2400,
    "done": 2600,
}
EXPECTED_FRAMES = 24
SAFETY_MARGIN = 8
EXPECTED_SIZE = (256, 256)


def pixel_hash(image: Image.Image) -> str:
    rgba = image.convert("RGBA")
    transparent_pixels = rgba.getchannel("A").point(lambda alpha: 255 if alpha == 0 else 0)
    rgba.paste((0, 0, 0, 0), mask=transparent_pixels)
    digest = hashlib.sha256()
    digest.update(f"{rgba.width}x{rgba.height}".encode())
    digest.update(rgba.tobytes())
    return digest.hexdigest()


def validate_source_frames(pack: Path, state: str) -> list[str]:
    frame_dir = pack / "frames" / state
    frames = sorted(frame_dir.glob("*.png")) if frame_dir.is_dir() else []
    failures: list[str] = []
    if len(frames) != EXPECTED_FRAMES:
        failures.append(
            f"{pack}/{state}: expected {EXPECTED_FRAMES} PNG frames, found {len(frames)}"
        )
        return failures

    hashes: set[str] = set()
    for path in frames:
        try:
            with Image.open(path) as image:
                rgba = image.convert("RGBA")
        except (OSError, ValueError) as error:
            failures.append(f"{path}: cannot decode PNG: {error}")
            continue

        hashes.add(pixel_hash(rgba))
        corners = (
            rgba.getpixel((0, 0))[3],
            rgba.getpixel((rgba.width - 1, 0))[3],
            rgba.getpixel((0, rgba.height - 1))[3],
            rgba.getpixel((rgba.width - 1, rgba.height - 1))[3],
        )
        if any(corners):
            failures.append(f"{path}: corners must be transparent, found alpha {corners}")

        bbox = rgba.getchannel("A").getbbox()
        if bbox is None:
            failures.append(f"{path}: frame has no opaque pixels")
        elif (
            bbox[0] < SAFETY_MARGIN
            or bbox[1] < SAFETY_MARGIN
            or rgba.width - bbox[2] < SAFETY_MARGIN
            or rgba.height - bbox[3] < SAFETY_MARGIN
        ):
            failures.append(
                f"{state}/{path.name}: opaque bbox violates {SAFETY_MARGIN}px safety margin "
                f"({bbox} in {rgba.width}x{rgba.height})"
            )

    if len(hashes) != EXPECTED_FRAMES:
        failures.append(
            f"{pack}/{state}: expected {EXPECTED_FRAMES} pixel-unique PNG frames, "
            f"found {len(hashes)}"
        )
    return failures


def validate_webp(pack: Path, state: str) -> list[str]:
    path = pack / "webp" / f"{state}.webp"
    if not path.is_file():
        return [f"{path}: missing animated WebP"]

    try:
        image = Image.open(path)
    except (OSError, ValueError) as error:
        return [f"{path}: cannot decode WebP: {error}"]

    frame_count = getattr(image, "n_frames", 1)
    failures: list[str] = []
    if image.size != EXPECTED_SIZE:
        failures.append(
            f"{path.name}: expected 256x256 canvas, "
            f"found {image.width}x{image.height}"
        )

    loop = image.info.get("loop")
    if loop != 0:
        failures.append(
            f"{path.name}: expected infinite loop (loop=0), found loop={loop}"
        )

    if frame_count != EXPECTED_FRAMES:
        failures.append(
            f"{path.name}: expected {EXPECTED_FRAMES} decoded frames, found {frame_count}"
        )

    hashes: set[str] = set()
    total_duration = 0
    try:
        for index in range(frame_count):
            image.seek(index)
            image.load()
            hashes.add(pixel_hash(image))
            duration = image.info.get("duration")
            if not isinstance(duration, int):
                failures.append(
                    f"{path.name}: frame {index} has invalid duration {duration!r}"
                )
            else:
                total_duration += duration
    except (EOFError, OSError, ValueError) as error:
        failures.append(f"{path}: cannot decode all WebP frames: {error}")
    finally:
        image.close()

    if len(hashes) != EXPECTED_FRAMES:
        failures.append(
            f"{path.name}: expected {EXPECTED_FRAMES} pixel-unique decoded frames, "
            f"found {len(hashes)}"
        )
    expected_duration = STATE_DURATIONS[state]
    if total_duration != expected_duration:
        failures.append(
            f"{path.name}: expected total duration {expected_duration}ms, "
            f"found {total_duration}ms"
        )
    return failures


def validate_pack(pack: Path) -> list[str]:
    return [
        failure
        for state in STATES
        for failure in (*validate_source_frames(pack, state), *validate_webp(pack, state))
    ]


def main() -> None:
    packs = [Path(value) for value in sys.argv[1:]]
    if not packs:
        print(
            "usage: validate-pet-motion.py <pack-directory> [<pack-directory> ...]",
            file=sys.stderr,
        )
        raise SystemExit(2)

    failures = [failure for pack in packs for failure in validate_pack(pack)]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        raise SystemExit(1)
    print(f"validated {len(packs)} pet packs with 24 unique motion frames per state")


if __name__ == "__main__":
    main()
