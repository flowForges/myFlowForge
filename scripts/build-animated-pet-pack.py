#!/usr/bin/env python3
"""Build a 24-frame pet pack from 8 keys and two 8-frame inbetween sheets."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
PACK = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
STATES = {
    "idle": (24, 3200),
    "working": (24, 2400),
    "confirm": (24, 2400),
    "input": (24, 2400),
    "done": (24, 2600),
}
CHROMA_HELPER = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / (
    "skills/.system/imagegen/scripts/remove_chroma_key.py"
)


def durations(frame_count: int, total_ms: int) -> list[int]:
    base, remainder = divmod(total_ms, frame_count)
    return [base + (1 if i < remainder else 0) for i in range(frame_count)]


def input_sheet_paths(pack: Path, state: str) -> tuple[Path, Path, Path]:
    return (
        pack / "source" / f"{state}-sheet.png",
        pack / "inbetweens" / f"{state}-one-third-sheet.png",
        pack / "inbetweens" / f"{state}-two-thirds-sheet.png",
    )


def crop_sheet_cells(sheet: Image.Image) -> list[Image.Image]:
    """Return all cells from a row-major 4x2 sheet, without dropping pixels."""
    cells = []
    for index in range(8):
        col, row = index % 4, index // 4
        left = round(sheet.width * col / 4)
        right = round(sheet.width * (col + 1) / 4)
        top = round(sheet.height * row / 2)
        bottom = round(sheet.height * (row + 1) / 2)
        cells.append(sheet.crop((left, top, right, bottom)))
    return cells


def interleave_frames(
    keys: list[Image.Image],
    one_thirds: list[Image.Image],
    two_thirds: list[Image.Image],
) -> list[Image.Image]:
    """Place two authored inbetweens after each original keyframe."""
    groups = (keys, one_thirds, two_thirds)
    if any(len(group) != 8 for group in groups):
        counts = ", ".join(str(len(group)) for group in groups)
        raise ValueError(f"expected exactly 8 frames from each input sheet, found {counts}")
    return [
        frame.copy()
        for index in range(8)
        for frame in (keys[index], one_thirds[index], two_thirds[index])
    ]


def gif_frame(image: Image.Image) -> Image.Image:
    """Quantize RGBA while reserving palette index 255 for transparency."""
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    paletted = rgba.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    palette = (paletted.getpalette() or [])[: 255 * 3]
    palette.extend([0] * (768 - len(palette)))
    paletted.putpalette(palette)
    transparent = alpha.point(lambda value: 255 if value <= 24 else 0)
    paletted.paste(255, mask=transparent)
    paletted.info["transparency"] = 255
    return paletted


def keep_subject_components(image: Image.Image) -> Image.Image:
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

    # Generated sheets can leak a sliver of the neighbouring cell into a
    # frame. The pet is the dominant connected component; keeping nearby
    # components reintroduces those border fragments.
    keep = set(max(components, key=len, default=set()))

    cleaned = image.copy()
    pixels = cleaned.load()
    for y in range(image.height):
        for x in range(image.width):
            if alpha.getpixel((x, y)) > 24 and (x, y) not in keep:
                pixels[x, y] = (0, 0, 0, 0)
    return cleaned


def fit_subject(image: Image.Image) -> Image.Image:
    cleaned = keep_subject_components(image)
    bbox = cleaned.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("chroma removal left no visible subject")
    subject = cleaned.crop(bbox)
    scale = min(232 / subject.width, 232 / subject.height)
    resized = subject.resize(
        (max(1, round(subject.width * scale)), max(1, round(subject.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((256 - resized.width) // 2, (256 - resized.height) // 2))
    return canvas


def split_sheet(sheet_path: Path, state: str, offset: int) -> list[Image.Image]:
    sheet = Image.open(sheet_path).convert("RGB")
    frames_dir = PACK / "frames" / state
    frames_dir.mkdir(parents=True, exist_ok=True)

    frames: list[Image.Image] = []
    with tempfile.TemporaryDirectory(prefix=f"animated-pet-{state}-") as raw_name:
        raw_dir = Path(raw_name)
        for index, cell in enumerate(crop_sheet_cells(sheet)):
            raw_path = raw_dir / f"{index:02d}.png"
            keyed_path = raw_dir / f"{index:02d}-alpha.png"
            cell.save(raw_path)
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
            canvas = fit_subject(keyed)
            frame_path = frames_dir / f"{offset + index * 3:02d}.png"
            canvas.save(frame_path, optimize=True)
            frames.append(canvas)

    return frames


def encode_state(state: str, keys: list[Image.Image], frame_count: int, total_ms: int) -> None:
    if frame_count != 24:
        raise ValueError(f"{state}: output contract requires 24 frames, got {frame_count}")
    output = keys
    if len(output) != 24:
        raise ValueError(f"{state}: expected exactly 24 interleaved frames, found {len(output)}")
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
    gif_output = [gif_frame(frame) for frame in output]
    gif_output[0].save(
        PACK / f"{state}.gif",
        format="GIF",
        save_all=True,
        append_images=gif_output[1:],
        duration=frame_durations,
        loop=0,
        disposal=2,
        transparency=255,
        background=255,
        optimize=False,
    )
    output[0].save(PACK / "png" / f"{state}.png", optimize=True)


def main() -> None:
    if PACK is None:
        raise SystemExit("usage: build-animated-pet-pack.py <pet-pack-directory>")
    missing = [path for state in STATES for path in input_sheet_paths(PACK, state) if not path.exists()]
    if missing:
        raise SystemExit("missing sprite sheets: " + ", ".join(str(path) for path in missing))
    if not CHROMA_HELPER.exists():
        raise SystemExit(f"missing chroma helper: {CHROMA_HELPER}")
    for state, (frame_count, total_ms) in STATES.items():
        key_path, one_third_path, two_thirds_path = input_sheet_paths(PACK, state)
        keys = split_sheet(key_path, state, 0)
        one_thirds = split_sheet(one_third_path, state, 1)
        two_thirds = split_sheet(two_thirds_path, state, 2)
        encode_state(state, interleave_frames(keys, one_thirds, two_thirds), frame_count, total_ms)
        print(f"built {state}: {frame_count} frames / {total_ms} ms")


if __name__ == "__main__":
    main()
