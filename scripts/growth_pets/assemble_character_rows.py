from __future__ import annotations

import argparse
from collections import Counter, deque
from pathlib import Path

from PIL import Image

CELL_SIZE = 120
CELL_COUNT = 6
ROW_WIDTH = CELL_SIZE * CELL_COUNT
ROW_HEIGHT = CELL_SIZE
HORIZONTAL_PADDING = 8
TOP_PADDING = 8
BASELINE_Y = 109
KEY_TOLERANCE = 16
GREEN_KEY_MINIMUM = 20
GREEN_KEY_DOMINANCE = 10
MIN_PRIMARY_AREA_RATIO = 0.35
MIN_OUTPUT_ALPHA = 24


def _border_key_color(image: Image.Image) -> tuple[int, int, int, int]:
    width, height = image.size
    pixels: list[tuple[int, int, int, int]] = []
    for x in range(width):
        pixels.append(image.getpixel((x, 0)))
        pixels.append(image.getpixel((x, height - 1)))
    for y in range(1, height - 1):
        pixels.append(image.getpixel((0, y)))
        pixels.append(image.getpixel((width - 1, y)))
    return Counter(pixels).most_common(1)[0][0]


def _is_chroma(pixel: tuple[int, int, int, int], key: tuple[int, int, int, int]) -> bool:
    if pixel[3] == 0:
        return True
    if all(abs(channel - key_channel) <= KEY_TOLERANCE for channel, key_channel in zip(pixel, key)):
        return True
    red, green, blue, _ = pixel
    key_is_green = key[1] - key[0] > GREEN_KEY_DOMINANCE and key[1] - key[2] > GREEN_KEY_DOMINANCE
    return (
        key_is_green
        and green > GREEN_KEY_MINIMUM
        and green - red > GREEN_KEY_DOMINANCE
        and green - blue > GREEN_KEY_DOMINANCE
    )


def _is_foreground(pixel: tuple[int, int, int, int], key: tuple[int, int, int, int]) -> bool:
    return not _is_chroma(pixel, key)


def _components(image: Image.Image, key: tuple[int, int, int, int]) -> list[tuple[int, int, int, int]]:
    width, height = image.size
    visited = [[False] * width for _ in range(height)]
    boxes: list[tuple[int, int, int, int]] = []

    for y in range(height):
        for x in range(width):
            if visited[y][x]:
                continue
            visited[y][x] = True
            if not _is_foreground(image.getpixel((x, y)), key):
                continue

            queue: deque[tuple[int, int]] = deque([(x, y)])
            min_x = max_x = x
            min_y = max_y = y
            while queue:
                current_x, current_y = queue.popleft()
                min_x = min(min_x, current_x)
                min_y = min(min_y, current_y)
                max_x = max(max_x, current_x)
                max_y = max(max_y, current_y)
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
                    if _is_foreground(image.getpixel((next_x, next_y)), key):
                        queue.append((next_x, next_y))
            boxes.append((min_x, min_y, max_x + 1, max_y + 1))
    return boxes


def _box_area(box: tuple[int, int, int, int]) -> int:
    left, top, right, bottom = box
    return (right - left) * (bottom - top)


def _box_center_x(box: tuple[int, int, int, int]) -> float:
    left, _, right, _ = box
    return (left + right) / 2


def _horizontal_distance(box: tuple[int, int, int, int], anchor: tuple[int, int, int, int]) -> float:
    left, _, right, _ = box
    anchor_left, _, anchor_right, _ = anchor
    overlap = min(right, anchor_right) - max(left, anchor_left)
    if overlap > 0:
        return 0.0
    if right <= anchor_left:
        return float(anchor_left - right)
    return float(left - anchor_right)


def _sprite_from_box(image: Image.Image, box: tuple[int, int, int, int], key: tuple[int, int, int, int]) -> Image.Image:
    sprite = image.crop(box).convert("RGBA")
    pixels = sprite.load()
    for y in range(sprite.height):
        for x in range(sprite.width):
            if not _is_foreground(pixels[x, y], key):
                pixels[x, y] = (0, 0, 0, 0)
    return sprite


def _pose_groups_from_components(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    if len(boxes) < CELL_COUNT:
        raise ValueError(f"expected exactly 6 pose groups, found {len(boxes)}")

    ranked = sorted(boxes, key=_box_area, reverse=True)
    primary = ranked[:CELL_COUNT]
    primary_areas = sorted(_box_area(box) for box in primary)
    median_area = (primary_areas[2] + primary_areas[3]) / 2
    if primary_areas[0] < median_area * MIN_PRIMARY_AREA_RATIO:
        raise ValueError("expected exactly 6 pose groups, found fewer than 6 primary poses")

    anchors = sorted(primary, key=lambda box: _box_center_x(box))
    assignments: list[list[tuple[int, int, int, int]]] = [[anchor] for anchor in anchors]
    anchor_ids = {id(anchor) for anchor in anchors}

    for box in boxes:
        if id(box) in anchor_ids:
            continue
        best_index = min(
            range(len(anchors)),
            key=lambda index: (
                _horizontal_distance(box, anchors[index]),
                abs(_box_center_x(box) - _box_center_x(anchors[index])),
            ),
        )
        assignments[best_index].append(box)

    pose_groups: list[tuple[int, int, int, int]] = []
    for group in assignments:
        left = min(box[0] for box in group)
        top = min(box[1] for box in group)
        right = max(box[2] for box in group)
        bottom = max(box[3] for box in group)
        pose_groups.append((left, top, right, bottom))
    return pose_groups


def assemble_character_row(source_path: Path, output_path: Path) -> None:
    with Image.open(source_path) as source_image:
        source = source_image.convert("RGBA")

    key = _border_key_color(source)
    boxes = sorted(_components(source, key), key=lambda box: box[0])
    pose_groups = _pose_groups_from_components(boxes)

    sprites = [_sprite_from_box(source, box, key) for box in pose_groups]
    max_width = max(sprite.width for sprite in sprites)
    max_height = max(sprite.height for sprite in sprites)
    scale = min(
        (CELL_SIZE - HORIZONTAL_PADDING * 2) / max_width,
        (BASELINE_Y - TOP_PADDING + 1) / max_height,
    )

    row = Image.new("RGBA", (ROW_WIDTH, ROW_HEIGHT), (0, 0, 0, 0))
    for index, sprite in enumerate(sprites):
        scaled_width = max(1, round(sprite.width * scale))
        scaled_height = max(1, round(sprite.height * scale))
        resized = sprite.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
        x = index * CELL_SIZE + (CELL_SIZE - scaled_width) // 2
        y = BASELINE_Y - scaled_height + 1
        row.alpha_composite(resized, (x, y))

    pixels = row.load()
    for y in range(row.height):
        for x in range(row.width):
            if pixels[x, y][3] < MIN_OUTPUT_ALPHA:
                pixels[x, y] = (0, 0, 0, 0)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    row.save(output_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Assemble six keyed poses into a 720x120 RGBA sprite row.")
    parser.add_argument("source_path", type=Path)
    parser.add_argument("output_path", type=Path)
    arguments = parser.parse_args()
    assemble_character_row(arguments.source_path, arguments.output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
