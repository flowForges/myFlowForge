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
GROUP_GAP_TOLERANCE = 12


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


def _is_foreground(pixel: tuple[int, int, int, int], key: tuple[int, int, int, int]) -> bool:
    return any(abs(channel - key_channel) > KEY_TOLERANCE for channel, key_channel in zip(pixel, key))


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


def _sprite_from_box(image: Image.Image, box: tuple[int, int, int, int], key: tuple[int, int, int, int]) -> Image.Image:
    sprite = image.crop(box).convert("RGBA")
    pixels = sprite.load()
    for y in range(sprite.height):
        for x in range(sprite.width):
            if not _is_foreground(pixels[x, y], key):
                pixels[x, y] = (0, 0, 0, 0)
    return sprite


def _merge_pose_groups(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    if not boxes:
        return []

    groups: list[list[int]] = [list(boxes[0])]
    for left, top, right, bottom in boxes[1:]:
        current = groups[-1]
        current_left, current_top, current_right, current_bottom = current
        if left <= current_right + GROUP_GAP_TOLERANCE:
            current[0] = min(current_left, left)
            current[1] = min(current_top, top)
            current[2] = max(current_right, right)
            current[3] = max(current_bottom, bottom)
            continue
        groups.append([left, top, right, bottom])
    return [tuple(group) for group in groups]


def assemble_character_row(source_path: Path, output_path: Path) -> None:
    with Image.open(source_path) as source_image:
        source = source_image.convert("RGBA")

    key = _border_key_color(source)
    boxes = sorted(_components(source, key), key=lambda box: box[0])
    pose_groups = _merge_pose_groups(boxes)
    if len(pose_groups) != CELL_COUNT:
        raise ValueError(f"expected exactly 6 pose groups, found {len(pose_groups)}")

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
