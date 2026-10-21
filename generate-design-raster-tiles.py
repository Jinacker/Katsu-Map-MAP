"""Render the event QGIS project to Kakao native WebP tiles.

Run with the Python bundled in QGIS (cwebp is also required):
  /Applications/QGIS-LTR.app/Contents/MacOS/bin/python3.9 generate-design-raster-tiles.py \
    ~/Desktop/seongbuk_developer_v3
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

# The bundled interpreter does not export PROJ/GDAL data paths by itself.
_RESOURCES = Path(sys.executable).parents[2] / "Resources"
for _name, _folder in (("PROJ_LIB", "proj"), ("PROJ_DATA", "proj"), ("GDAL_DATA", "gdal")):
    if (_RESOURCES / _folder).is_dir():
        os.environ.setdefault(_name, str(_RESOURCES / _folder))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from qgis.core import (  # noqa: E402
    QgsApplication, QgsCoordinateReferenceSystem, QgsCoordinateTransform, QgsMapRendererParallelJob,
    QgsMapSettings, QgsPointXY, QgsProject, QgsRectangle,
)
from qgis.PyQt.QtCore import QSize  # noqa: E402
from qgis.PyQt.QtGui import QImage  # noqa: E402

TILE_SIZE, PIXEL_RATIO = 512, 2
# 192 DPI at DPR 2 keeps the project's mm line widths at 0.3 CSS px and makes
# QGIS switch parcel detail/overview at 1:6500 exactly between levels 3 and 4.
OUTPUT_DPI = 96 * PIXEL_RATIO
MIN_LEVEL, MAX_LEVEL = 3, 7
VERSION = "20261021-v3"
# Camera centres stay inside the navigation bounds, so only tiles within half of
# the largest supported viewport (tablets included) around them can be seen.
MAX_HALF_VIEWPORT_CSS = 700
# WCONG = EPSG:5181 * 2.5; Kakao's native tile plane adds *3.2 and
# offsets (240000, 480000). EPSG:5186 northing is EPSG:5181 + 100000.
# Thus native = (EPSG:5186 X * 8 + 240000, Y * 8 - 320000).
NATIVE_SCALE, OFFSET_X, OFFSET_Y = 8, 240000, -320000
WEBP_OPTIONS = ["-q", "80", "-m", "6", "-sharp_yuv", "-metadata", "none"]


def project_box(transform, bounds):
    """Return the largest EPSG:5186 rectangle inside a projected EPSG:3857 box."""
    west, south, east, north = bounds
    corners = [transform.transform(QgsPointXY(x, y)) for x, y in
               ((west, south), (west, north), (east, south), (east, north))]
    xs = sorted(point.x() for point in corners)
    ys = sorted(point.y() for point in corners)
    return xs[1], ys[1], xs[2], ys[2]


def wcong(box):
    west, south, east, north = box
    return {"west": round(west * 2.5, 2), "east": round(east * 2.5, 2),
            "south": round((south - 100000) * 2.5, 2), "north": round((north - 100000) * 2.5, 2)}


def tile_range(level, box):
    west, south, east, north = box
    world_span = TILE_SIZE * 2 ** level
    return {"xMin": math.floor((west * NATIVE_SCALE + OFFSET_X) / world_span),
            "xMax": math.ceil((east * NATIVE_SCALE + OFFSET_X) / world_span) - 1,
            "yMin": math.floor((south * NATIVE_SCALE + OFFSET_Y) / world_span),
            "yMax": math.ceil((north * NATIVE_SCALE + OFFSET_Y) / world_span) - 1}


def visible_box(level, coverage, navigation):
    # One CSS px at level L spans 2**L native units, i.e. 2**L / 8 metres.
    margin = MAX_HALF_VIEWPORT_CSS * 2 ** level / NATIVE_SCALE
    return (max(coverage[0], navigation[0] - margin), max(coverage[1], navigation[1] - margin),
            min(coverage[2], navigation[2] + margin), min(coverage[3], navigation[3] + margin))


def encode(png, target, lossless=False):
    options = ["-lossless", "-exact"] if lossless else WEBP_OPTIONS
    subprocess.run(["cwebp", "-quiet", *options, str(png), "-o", str(target)], check=True)
    png.unlink()
    return target.stat().st_size


def generate(source, output, jobs):
    if shutil.which("cwebp") is None:
        raise RuntimeError("cwebp is required (brew install webp)")
    bounds = json.loads((source / "app" / "map_bounds.json").read_text(encoding="utf-8"))
    application = QgsApplication([], False)
    application.initQgis()
    try:
        project = QgsProject.instance()
        if not project.read(str(source / "qgis" / "event_map.qgz")):
            raise ValueError("Cannot read qgis/event_map.qgz")
        crs = QgsCoordinateReferenceSystem("EPSG:5186")
        if not crs.isValid():
            raise RuntimeError("EPSG:5186 is unavailable; check the PROJ data path")
        transform = QgsCoordinateTransform(QgsCoordinateReferenceSystem("EPSG:3857"), crs, project)
        coverage = project_box(transform, bounds["coverageBoundsMercator"])
        navigation = project_box(transform, bounds["navigationCenterBoundsMercator"])
        fit = project_box(transform, bounds["fitBoundsMercator"])

        # Render only the checked layers, in layer-tree order (water above parcels).
        # walk_points stays unchecked: the map uses its own pins instead.
        tree = project.layerTreeRoot()
        layers = [layer for layer in tree.layerOrder() if tree.findLayer(layer.id()).isVisible()]
        settings = QgsMapSettings()
        settings.setLayers(layers)
        settings.setDestinationCrs(crs)
        settings.setTransformContext(project.transformContext())
        settings.setBackgroundColor(project.backgroundColor())
        settings.setOutputSize(QSize(TILE_SIZE * PIXEL_RATIO, TILE_SIZE * PIXEL_RATIO))
        settings.setOutputDpi(OUTPUT_DPI)
        settings.setFlag(QgsMapSettings.Antialiasing, True)
        settings.setFlag(QgsMapSettings.RenderMapTile, True)

        output.mkdir(parents=True, exist_ok=True)
        scratch = Path(tempfile.mkdtemp(prefix="katsu-design-tiles-"))
        manifest = {
            "version": VERSION, "tileSize": TILE_SIZE, "pixelRatio": PIXEL_RATIO,
            "minLevel": MIN_LEVEL, "maxLevel": MAX_LEVEL, "levels": {},
            # boundsWcong keeps its earlier meaning (the design extent) for cached HTML.
            "boundsWcong": wcong(coverage), "navigationWcong": wcong(navigation), "fitWcong": wcong(fit),
        }
        counts, total_bytes = {}, 0
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            # Shared tile for loading and any area outside the rendered range.
            blank = QImage(1, 1, QImage.Format_RGB32)
            blank.fill(project.backgroundColor())
            blank.save(str(scratch / "blank.png"), "PNG")
            pending = [pool.submit(encode, scratch / "blank.png", output / "blank.webp", True)]
            for level in range(MIN_LEVEL, MAX_LEVEL + 1):
                tiles = tile_range(level, visible_box(level, coverage, navigation))
                manifest["levels"][str(level)] = tiles
                level_dir = output / str(level)
                level_dir.mkdir(exist_ok=True)
                for stale in level_dir.glob("*.webp"):
                    stale.unlink()
                world_span = TILE_SIZE * 2 ** level
                span = world_span / NATIVE_SCALE
                for y in range(tiles["yMin"], tiles["yMax"] + 1):
                    for x in range(tiles["xMin"], tiles["xMax"] + 1):
                        west = (x * world_span - OFFSET_X) / NATIVE_SCALE
                        south = (y * world_span - OFFSET_Y) / NATIVE_SCALE
                        settings.setExtent(QgsRectangle(west, south, west + span, south + span))
                        job = QgsMapRendererParallelJob(settings)
                        job.start()
                        job.waitForFinished()
                        png = scratch / f"{level}-{x}-{y}.png"
                        if not job.renderedImage().save(str(png), "PNG"):
                            raise RuntimeError(f"Cannot render {level}/{x}-{y}")
                        pending.append(pool.submit(encode, png, level_dir / f"{x}-{y}.webp"))
                counts[level] = (tiles["xMax"] - tiles["xMin"] + 1) * (tiles["yMax"] - tiles["yMin"] + 1)
                print(f"Level {level}: {counts[level]} tiles", flush=True)
            for future in pending:
                total_bytes += future.result()
        shutil.rmtree(scratch, ignore_errors=True)
    finally:
        application.exitQgis()
    (output / "manifest.js").write_text(
        "window.KatsuEventDesignTiles = " + json.dumps(manifest, ensure_ascii=False, indent=2) + ";\n",
        encoding="utf-8",
    )
    print(f"Generated {sum(counts.values())} 2x WebP tiles ({total_bytes:,} bytes) in {output}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="Delivery folder containing qgis/event_map.qgz and app/map_bounds.json")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles" / "raster")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 4, help="Parallel WebP encoders")
    args = parser.parse_args()
    generate(args.source.expanduser(), args.output, max(1, args.jobs))
