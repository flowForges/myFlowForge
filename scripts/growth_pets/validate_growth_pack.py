#!/usr/bin/env python3
"""Strict validator for the documented growth-pet authoring contract."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image

ALLOWED_EXTENSIONS = {".svg", ".png", ".webp", ".gif"}
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_pack(pack_dir: Path) -> list[str]:
    errors: list[str] = []
    manifest_path = pack_dir / "pet.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"pet.json: {exc}"]

    if not isinstance(manifest, dict):
        return ["pet.json root must be an object"]
    if not isinstance(manifest.get("id"), str) or not ID_PATTERN.fullmatch(manifest["id"]):
        errors.append("id must contain only lowercase letters, digits, and hyphens")
    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        errors.append("name must be a non-empty string")
    if manifest.get("kind") != "growth":
        errors.append('kind must be "growth"')
    if manifest.get("signal") != "dailyTokens":
        errors.append('signal must be "dailyTokens"')

    atlas = manifest.get("atlas")
    if not isinstance(atlas, dict):
        errors.append("atlas must be an object")
        atlas = {}
    cols, cell_w, cell_h = atlas.get("cols"), atlas.get("cellW"), atlas.get("cellH")
    for key, value in (("cols", cols), ("cellW", cell_w), ("cellH", cell_h)):
        if not _positive_int(value):
            errors.append(f"atlas.{key} must be a positive integer")
    if _positive_int(cell_w) and _positive_int(cell_h) and cell_w != cell_h:
        errors.append("atlas cells must be square")

    actions = manifest.get("actions")
    if not isinstance(actions, dict) or "idle" not in actions:
        errors.append("actions must be an object containing idle")
        actions = {}
    rows: list[int] = []
    for action_name, action in actions.items():
        if action_name not in {"idle", "working", "alert"}:
            errors.append(f"unsupported action: {action_name}")
            continue
        if not isinstance(action, dict):
            errors.append(f"actions.{action_name} must be an object")
            continue
        row = action.get("row")
        durations = action.get("durations")
        if not isinstance(row, int) or isinstance(row, bool) or row < 0:
            errors.append(f"actions.{action_name}.row must be a non-negative integer")
        else:
            rows.append(row)
        if not isinstance(durations, list) or not durations:
            errors.append(f"actions.{action_name}.durations must be non-empty")
        elif any(not _positive_int(duration) for duration in durations):
            errors.append(f"actions.{action_name}.durations must contain positive integers")
        elif _positive_int(cols) and len(durations) > cols:
            errors.append(f"actions.{action_name}.durations exceeds atlas.cols")
    if len(rows) != len(set(rows)):
        errors.append("action rows must be unique")
    if rows and sorted(rows) != list(range(len(rows))):
        errors.append("action rows must start at 0 and be continuous")
    row_count = len(rows)

    stages = manifest.get("stages")
    if not isinstance(stages, list) or not stages:
        errors.append("stages must be a non-empty array")
        stages = []
    previous = -1.0
    for index, stage in enumerate(stages):
        if not isinstance(stage, dict):
            errors.append(f"stages[{index}] must be an object")
            continue
        at = stage.get("at")
        if not isinstance(at, (int, float)) or isinstance(at, bool) or not 0 <= at <= 1:
            errors.append(f"stages[{index}].at must be between 0 and 1")
        else:
            if index == 0 and at != 0:
                errors.append("stages[0].at must equal 0")
            if at <= previous:
                errors.append("stage thresholds must be strictly increasing")
            previous = float(at)
        sheet = stage.get("sheet")
        if not isinstance(sheet, str) or not sheet:
            errors.append(f"stages[{index}].sheet must be non-empty")
            continue
        pure = PurePosixPath(sheet)
        if pure.is_absolute() or ".." in pure.parts or "\\" in sheet:
            errors.append(f"stages[{index}].sheet must be a safe relative path")
            continue
        if pure.suffix.lower() not in ALLOWED_EXTENSIONS:
            errors.append(f"stages[{index}].sheet has an unsupported extension")
            continue
        image_path = pack_dir / sheet
        if not image_path.is_file():
            errors.append(f"missing sheet: {sheet}")
            continue
        if pure.suffix.lower() == ".svg":
            continue
        try:
            with Image.open(image_path) as image:
                expected = (
                    cols * cell_w if _positive_int(cols) and _positive_int(cell_w) else None,
                    row_count * cell_h if row_count and _positive_int(cell_h) else None,
                )
                if None not in expected and image.size != expected:
                    errors.append(f"{sheet}: expected {expected[0]}x{expected[1]}, got {image.width}x{image.height}")
                if "A" not in image.getbands():
                    errors.append(f"{sheet}: image must have an alpha channel")
                else:
                    if any(image.getpixel(point)[-1] != 0 for point in ((0, 0), (image.width - 1, 0), (0, image.height - 1), (image.width - 1, image.height - 1))):
                        errors.append(f"{sheet}: atlas corners must be transparent")
                    if _positive_int(cols) and _positive_int(cell_w) and _positive_int(cell_h):
                        alpha = image.getchannel("A")
                        for row in range(row_count):
                            for col in range(cols):
                                cell = alpha.crop((
                                    col * cell_w,
                                    row * cell_h,
                                    (col + 1) * cell_w,
                                    (row + 1) * cell_h,
                                ))
                                bbox = cell.getbbox()
                                label = f"{sheet}: cell ({col},{row})"
                                if bbox is None:
                                    errors.append(f"{label} is empty")
                                elif bbox[0] == 0 or bbox[1] == 0 or bbox[2] == cell_w or bbox[3] == cell_h:
                                    errors.append(f"{label} touches an edge and may be clipped")
        except OSError as exc:
            errors.append(f"{sheet}: cannot read image: {exc}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pack_dir", type=Path)
    args = parser.parse_args()
    errors = validate_pack(args.pack_dir)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        raise SystemExit(1)
    print(f"OK: {args.pack_dir} is a valid growth pet pack")


if __name__ == "__main__":
    main()
