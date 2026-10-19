"""Render the design SVG sources to Kakao WCONG tiles (requires PyQt5)."""

import argparse
import json
import math
from pathlib import Path

from PyQt5.QtCore import QByteArray, QRectF
from PyQt5.QtGui import QColor, QGuiApplication, QImage, QPainter
from PyQt5.QtSvg import QSvgRenderer


WEST, NORTH = 198700, 556700
SOURCE_SIZE = 512
COLUMNS, ROWS = 12, 10
EAST, SOUTH = WEST + COLUMNS * SOURCE_SIZE, NORTH - ROWS * SOURCE_SIZE
TILE_SIZE, PIXEL_RATIO = 256, 2
MIN_LEVEL, MAX_LEVEL = 1, 7
VERSION = "20261019-native-1"


def generate(source, output):
    # Kakao WCONG = EPSG:5181 * 2.5. EPSG:5186 has the same projection,
    # with false northing 600000 instead of 500000, hence the 100000 offset.
    # Native tile (x, y, level) has its southwest at (x, y)*256*2**level.
    output.mkdir(parents=True, exist_ok=True)
    black = QImage(1, 1, QImage.Format_RGB32)
    black.fill(QColor("#000000"))
    if not black.save(str(output / "black.webp"), "WEBP", 100):
        raise RuntimeError("Cannot write the outside-area tile")
    svg_sources = {
        (column, row): (source / f"{column}-{row}.svg").read_text(encoding="utf-8")
        for row in range(ROWS) for column in range(COLUMNS)
    }
    manifest = {
        "version": VERSION, "tileSize": TILE_SIZE, "pixelRatio": PIXEL_RATIO,
        "minLevel": MIN_LEVEL, "maxLevel": MAX_LEVEL, "levels": {},
    }
    count, total_bytes = 0, 0
    for level in range(MIN_LEVEL, MAX_LEVEL + 1):
        world_span = TILE_SIZE * 2 ** level
        span = world_span / 2.5
        units_per_pixel = span / (TILE_SIZE * PIXEL_RATIO)
        x_min = math.floor(WEST * 2.5 / world_span)
        x_max = math.ceil(EAST * 2.5 / world_span) - 1
        y_min = math.floor((SOUTH - 100000) * 2.5 / world_span)
        y_max = math.ceil((NORTH - 100000) * 2.5 / world_span) - 1
        manifest["levels"][str(level)] = {"xMin": x_min, "xMax": x_max, "yMin": y_min, "yMax": y_max}
        directory = output / str(level)
        directory.mkdir(exist_ok=True)
        # Match the original fine 0.4 CSS-pixel outline. Rasterize it at 2x
        # physical resolution now; the browser never parses these SVG paths.
        stroke = 0.4 * span / TILE_SIZE
        renderers = {
            key: QSvgRenderer(QByteArray(svg.replace('stroke-width="0.4"', f'stroke-width="{stroke}"')
                .replace(' vector-effect="non-scaling-stroke"', '').encode("utf-8")))
            for key, svg in svg_sources.items()
        }
        for renderer in renderers.values():
            if not renderer.isValid():
                raise ValueError("Cannot render a source SVG")
        level_count = 0
        for y in range(y_min, y_max + 1):
            for x in range(x_min, x_max + 1):
                west, north = x * span, (y + 1) * span + 100000
                east, south = west + span, north - span
                image = QImage(TILE_SIZE * PIXEL_RATIO, TILE_SIZE * PIXEL_RATIO, QImage.Format_RGB32)
                image.fill(QColor("#000000"))
                painter = QPainter(image)
                painter.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
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
                            renderers[(column, row)].render(painter, target)
                finally:
                    painter.end()
                target = directory / f"{x}-{y}.webp"
                if not image.save(str(target), "WEBP", 90):
                    raise RuntimeError(f"Cannot write {target}")
                total_bytes += target.stat().st_size
                count += 1
                level_count += 1
        print(f"Level {level}: {level_count} tiles", flush=True)

    # The manifest is loaded synchronously before map creation: no camera change
    # or base-map replacement after the first frame.
    (output / "manifest.js").write_text(
        "window.KatsuEventDesignTiles = " + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(f"Generated {count} 2x WebP tiles ({total_bytes:,} bytes) in {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles" / "raster")
    args = parser.parse_args()
    application = QGuiApplication([])
    generate(args.source, args.output)
