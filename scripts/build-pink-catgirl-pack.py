#!/usr/bin/env python3
"""Build the approved pink-catgirl animation pack from 4x2 sprite sheets."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "assets" / "pet-packs" / "pink-catgirl"
STATES = {
    "idle": (24, 2000),
    "working": (24, 1500),
    "confirm": (18, 1200),
    "input": (24, 1600),
    "done": (24, 1800),
}
CHROMA_HELPER = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / (
    "skills/.system/imagegen/scripts/remove_chroma_key.py"
)


def durations(frame_count: int, total_ms: int) -> list[int]:
    base, remainder = divmod(total_ms, frame_count)
    return [base + (1 if i < remainder else 0) for i in range(frame_count)]


def sequence(keyframes: list[Image.Image], frame_count: int) -> list[Image.Image]:
    return [keyframes[(i * len(keyframes)) // frame_count].copy() for i in range(frame_count)]


def keep_largest_component(image: Image.Image) -> Image.Image:
    alpha = image.getchannel("A")
    active = set()
    for y in range(image.height):
        for x in range(image.width):
            if alpha.getpixel((x, y)) > 24:
                active.add((x, y))

    components = []
    while active:
        seed = active.pop()
        component = {seed}
        stack = [seed]
        while stack:
            x, y = stack.pop()
            for point in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if point in active:
                    active.remove(point)
                    component.add(point)
                    stack.append(point)
        components.append(component)

    keep = max(components, key=len, default=set())

    cleaned = image.copy()
    pixels = cleaned.load()
    for y in range(image.height):
        for x in range(image.width):
            if alpha.getpixel((x, y)) > 24 and (x, y) not in keep:
                pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def split_sheet(state: str) -> list[Image.Image]:
    sheet_path = PACK / "source" / f"{state}-sheet.png"
    sheet = Image.open(sheet_path).convert("RGB")
    frames_dir = PACK / "frames" / state
    frames_dir.mkdir(parents=True, exist_ok=True)

    frames: list[Image.Image] = []
    with tempfile.TemporaryDirectory(prefix=f"pink-catgirl-{state}-") as raw_name:
        raw_dir = Path(raw_name)
        for index in range(8):
            col, row = index % 4, index // 4
            left = round(sheet.width * col / 4)
            right = round(sheet.width * (col + 1) / 4)
            top = round(sheet.height * row / 2)
            bottom = round(sheet.height * (row + 1) / 2)
            raw_path = raw_dir / f"{index:02d}.png"
            keyed_path = raw_dir / f"{index:02d}-alpha.png"
            sheet.crop((left, top, right, bottom)).save(raw_path)
            subprocess.run(
                [
                    sys.executable,
                    str(CHROMA_HELPER),
                    "--input",
                    str(raw_path),
                    "--out",
                    str(keyed_path),
                    "--auto-key",
                    "border",
                    "--soft-matte",
                    "--transparent-threshold",
                    "12",
                    "--opaque-threshold",
                    "220",
                    "--despill",
                ],
                check=True,
            )
            keyed = Image.open(keyed_path).convert("RGBA")
            scale = min(256 / keyed.width, 256 / keyed.height)
            resized = keyed.resize(
                (round(keyed.width * scale), round(keyed.height * scale)),
                Image.Resampling.LANCZOS,
            )
            canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
            canvas.alpha_composite(resized, ((256 - resized.width) // 2, (256 - resized.height) // 2))
            canvas = keep_largest_component(canvas)
            frame_path = frames_dir / f"{index:02d}.png"
            canvas.save(frame_path, optimize=True)
            frames.append(canvas)
    return frames


def encode_state(state: str, keys: list[Image.Image], frame_count: int, total_ms: int) -> None:
    output = sequence(keys, frame_count)
    frame_durations = durations(frame_count, total_ms)
    (PACK / "webp").mkdir(parents=True, exist_ok=True)
    (PACK / "apng").mkdir(parents=True, exist_ok=True)
    (PACK / "png").mkdir(parents=True, exist_ok=True)

    save_common = {
        "save_all": True,
        "append_images": output[1:],
        "duration": frame_durations,
        "loop": 0,
    }
    output[0].save(PACK / "webp" / f"{state}.webp", format="WEBP", lossless=True, method=6, **save_common)
    output[0].save(PACK / "apng" / f"{state}.png", format="PNG", disposal=2, blend=0, **save_common)
    output[0].save(
        PACK / f"{state}.gif",
        format="GIF",
        disposal=2,
        transparency=0,
        optimize=True,
        **save_common,
    )
    keys[0].save(PACK / "png" / f"{state}.png", optimize=True)


def main() -> None:
    if not CHROMA_HELPER.exists():
        raise SystemExit(f"missing chroma helper: {CHROMA_HELPER}")
    for state, (frame_count, total_ms) in STATES.items():
        encode_state(state, split_sheet(state), frame_count, total_ms)
        print(f"built {state}: {frame_count} frames / {total_ms} ms")


if __name__ == "__main__":
    main()
