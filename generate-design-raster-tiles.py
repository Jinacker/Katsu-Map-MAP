"""Render GIS SVG sources to Kakao native tiles (requires PyQt5)."""

import argparse
from concurrent.futures import ProcessPoolExecutor
import json
import math
import multiprocessing
from pathlib import Path

from PyQt5.QtCore import QByteArray, QRectF, Qt
from PyQt5.QtGui import QColor, QGuiApplication, QImage, QPainter
from PyQt5.QtSvg import QSvgRenderer

WEST, NORTH = 198700, 556700
SOURCE_SIZE = 512
COLUMNS, ROWS = 12, 10
EAST, SOUTH = WEST + COLUMNS * SOURCE_SIZE, NORTH - ROWS * SOURCE_SIZE
TILE_SIZE, PIXEL_RATIO = 512, 2
MIN_LEVEL, MAX_LEVEL = 3, 7
VERSION = "20261019-native-7"
OUTSIDE_COLOR = "#5e5e5e"
# WCONG = EPSG:5181 * 2.5; Kakao's native tile plane adds *3.2 and
# offsets (240000, 480000). EPSG:5186 northing is EPSG:5181 + 100000.
# Thus native = (EPSG:5186 X * 8 + 240000, Y * 8 - 320000).
NATIVE_SCALE, OFFSET_X, OFFSET_Y = 8, 240000, -320000
_application = None
_svg_sources = {}
_renderers = {}
_renderer_level = None


def initialize_worker(source):
    global _application, _svg_sources
    _application = QGuiApplication([])
    _svg_sources = {
        (column, row): (Path(source) / f"{column}-{row}.svg").read_text(encoding="utf-8")
        for row in range(ROWS) for column in range(COLUMNS)
    }


def render_tile(job):
    global _renderers, _renderer_level
    level, x, y, output = job
    world_span = TILE_SIZE * 2 ** level
    span = world_span / NATIVE_SCALE
    units_per_pixel = span / (TILE_SIZE * PIXEL_RATIO)
    if _renderer_level != level:
        # Dense building outlines need less visual weight as the map zooms out.
        css_stroke, color = {
            5: (0.28, "#626b73"),
            6: (0.20, "#7c858d"),
            7: (0.14, "#959fa7"),
        }.get(level, (0.4, "#232323"))
        stroke = css_stroke * span / TILE_SIZE
        _renderers = {
            key: QSvgRenderer(QByteArray(svg.replace('stroke-width="0.4"', f'stroke-width="{stroke}"')
                .replace('stroke="#232323"', f'stroke="{color}"')
                .replace(' vector-effect="non-scaling-stroke"', '').encode("utf-8")))
            for key, svg in _svg_sources.items()
        }
        if any(not renderer.isValid() for renderer in _renderers.values()):
            raise ValueError("Cannot render a source SVG")
        _renderer_level = level
    west = (x * world_span - OFFSET_X) / NATIVE_SCALE
    north = ((y + 1) * world_span - OFFSET_Y) / NATIVE_SCALE
    east, south = west + span, north - span
    image = QImage(TILE_SIZE * PIXEL_RATIO, TILE_SIZE * PIXEL_RATIO, QImage.Format_RGB32)
    image.fill(QColor(OUTSIDE_COLOR))
    painter = QPainter(image)
    painter.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
    # QtSvg does not reliably clip overflowing source paths to the root viewBox.
    # Explicitly keep all geometry inside the event's original design extent.
    design_rect = QRectF((WEST - west) / units_per_pixel,
                        (north - NORTH) / units_per_pixel,
                        (EAST - WEST) / units_per_pixel,
                        (NORTH - SOUTH) / units_per_pixel)
    painter.setClipRect(design_rect)
    # A continuous paper base prevents antialiased source edges from revealing
    # black hairlines between the individually clipped SVG viewports.
    painter.fillRect(design_rect, QColor("#fdfbf6"))
    try:
        first_column = max(0, math.floor((west - WEST) / SOURCE_SIZE))
        last_column = min(COLUMNS - 1, math.floor((east - WEST) / SOURCE_SIZE))
        first_row = max(0, math.floor((NORTH - north) / SOURCE_SIZE))
        last_row = min(ROWS - 1, math.floor((NORTH - south) / SOURCE_SIZE))
        for row in range(first_row, last_row + 1):
            for column in range(first_column, last_column + 1):
                tile_west, tile_north = WEST + column * SOURCE_SIZE, NORTH - row * SOURCE_SIZE
                target = QRectF(
                    (tile_west - west) / units_per_pixel,
                    (north - tile_north) / units_per_pixel,
                    SOURCE_SIZE / units_per_pixel, SOURCE_SIZE / units_per_pixel,
                )
                # Adjacent source tiles repeat crossing buildings. Clip each
                # source viewport so those outlines are not painted twice.
                painter.save()
                painter.setClipRect(target, Qt.IntersectClip)
                _renderers[(column, row)].render(painter, target)
                painter.restore()
    finally:
        painter.end()
    target = Path(output) / str(level) / f"{x}-{y}.webp"
    if not image.save(str(target), "WEBP", 90):
        raise RuntimeError(f"Cannot write {target}")
    return level, target.stat().st_size


def generate(source, output, jobs, edges_only=False):
    if edges_only and not (output / "manifest.js").exists():
        raise ValueError("An existing complete tile set is required for --edges-only")
    output.mkdir(parents=True, exist_ok=True)
    application = QGuiApplication([])
    outside = QImage(1, 1, QImage.Format_RGB32)
    outside.fill(QColor(OUTSIDE_COLOR))
    # Keep the existing shared-tile path; the manifest version invalidates caches.
    if not outside.save(str(output / "black.webp"), "WEBP", 100):
        raise RuntimeError("Cannot write the outside-area tile")
    manifest = {
        "version": VERSION, "tileSize": TILE_SIZE, "pixelRatio": PIXEL_RATIO,
        "minLevel": MIN_LEVEL, "maxLevel": MAX_LEVEL, "levels": {},
        "boundsWcong": {"west": WEST * 2.5, "east": EAST * 2.5,
                        "south": (SOUTH - 100000) * 2.5, "north": (NORTH - 100000) * 2.5},
    }
    work = []
    expected = {}
    for level in range(MIN_LEVEL, MAX_LEVEL + 1):
        world_span = TILE_SIZE * 2 ** level
        x_min = math.floor((WEST * NATIVE_SCALE + OFFSET_X) / world_span)
        x_max = math.ceil((EAST * NATIVE_SCALE + OFFSET_X) / world_span) - 1
        y_min = math.floor((SOUTH * NATIVE_SCALE + OFFSET_Y) / world_span)
        y_max = math.ceil((NORTH * NATIVE_SCALE + OFFSET_Y) / world_span) - 1
        manifest["levels"][str(level)] = {"xMin": x_min, "xMax": x_max, "yMin": y_min, "yMax": y_max}
        (output / str(level)).mkdir(exist_ok=True)
        level_jobs = []
        span = world_span / NATIVE_SCALE
        for y in range(y_min, y_max + 1):
            for x in range(x_min, x_max + 1):
                west = (x * world_span - OFFSET_X) / NATIVE_SCALE
                south = (y * world_span - OFFSET_Y) / NATIVE_SCALE
                interior = west >= WEST and west + span <= EAST and south >= SOUTH and south + span <= NORTH
                if not edges_only or not interior:
                    level_jobs.append((level, x, y, str(output)))
        expected[level] = len(level_jobs)
        work.extend(level_jobs)
    print(f"Rendering {len(work)} tiles using {jobs} processes", flush=True)
    counts = {level: 0 for level in expected}
    total_bytes = 0
    with ProcessPoolExecutor(max_workers=jobs, mp_context=multiprocessing.get_context("spawn"),
                             initializer=initialize_worker, initargs=(str(source),)) as pool:
        for level, size in pool.map(render_tile, work, chunksize=8):
            counts[level] += 1
            total_bytes += size
            if counts[level] == expected[level]:
                print(f"Level {level}: {counts[level]} tiles", flush=True)
            elif counts[level] % 256 == 0:
                print(f"Level {level}: {counts[level]}/{expected[level]}", flush=True)
    (output / "manifest.js").write_text(
        "window.KatsuEventDesignTiles = " + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(f"Generated {len(work)} 2x WebP tiles ({total_bytes:,} bytes) in {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles" / "raster")
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--edges-only", action="store_true", help="Update only boundary tiles of an existing set")
    args = parser.parse_args()
    generate(args.source, args.output, max(1, args.jobs), args.edges_only)
