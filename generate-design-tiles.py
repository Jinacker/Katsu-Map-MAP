"""Generate static SVG tiles from the supplied EPSG:5186 GeoPackage (requires GDAL)."""

import argparse
from pathlib import Path

from osgeo import ogr


WEST, NORTH = 198700, 556700
TILE_SIZE = 512
COLUMNS, ROWS = 12, 10


def number(value):
    return f"{value:.2f}".rstrip("0").rstrip(".") or "0"


def polygon_paths(geometry, west, north):
    """Keep holes and separate polygons; SVG clips the original building outlines."""
    kind = geometry.GetGeometryName()
    if kind == "POLYGON":
        rings = []
        for index in range(geometry.GetGeometryCount()):
            ring = geometry.GetGeometryRef(index)
            points = ring.GetPoints()
            if not points:
                continue
            coordinates = [f"{number(p[0] - west)},{number(north - p[1])}" for p in points]
            rings.append("M" + "L".join(coordinates) + "Z")
        return ["".join(rings)] if rings else []
    paths = []
    for index in range(geometry.GetGeometryCount()):
        paths.extend(polygon_paths(geometry.GetGeometryRef(index), west, north))
    return paths


def generate(source, output):
    ogr.UseExceptions()
    dataset = ogr.Open(str(source), 0)
    if dataset is None:
        raise ValueError("Cannot open the source GeoPackage")
    buildings = [layer for layer in dataset if layer.GetName().startswith("AL_D194_")]
    river = dataset.GetLayerByName("하천")
    if not buildings or river is None:
        raise ValueError("The source must contain the building layers and 하천")
    for layer in buildings + [river]:
        if layer.GetSpatialRef().GetAuthorityCode(None) != "5186":
            raise ValueError("The design tiles require source coordinates in EPSG:5186")

    output.mkdir(parents=True, exist_ok=True)
    total_bytes = 0
    for row in range(ROWS):
        for column in range(COLUMNS):
            west, north = WEST + column * TILE_SIZE, NORTH - row * TILE_SIZE
            east, south = west + TILE_SIZE, north - TILE_SIZE
            outlines, water = [], []
            # Clip filled river geometry, but keep building outlines intact: cutting
            # building polygons would draw false black lines along tile boundaries.
            clip = ogr.CreateGeometryFromWkt(
                f"POLYGON (({west-1} {south-1},{east+1} {south-1},"
                f"{east+1} {north+1},{west-1} {north+1},{west-1} {south-1}))"
            )
            for layer in buildings + [river]:
                layer.SetSpatialFilterRect(west - 1, south - 1, east + 1, north + 1)
                layer.ResetReading()
                for feature in layer:
                    geometry = feature.GetGeometryRef()
                    if geometry is None or geometry.IsEmpty():
                        continue
                    if layer.GetName() == "하천":
                        geometry = geometry.Intersection(clip)
                        if geometry is not None and not geometry.IsEmpty():
                            water.extend(polygon_paths(geometry, west, north))
                    else:
                        outlines.extend(polygon_paths(geometry, west, north))

            svg = [
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
                'width="512" height="512" overflow="hidden">',
                '<path fill="#fdfbf6" d="M0 0H512V512H0Z"/>',
                '<g fill="none" stroke="#232323" stroke-width="0.4" stroke-linejoin="round">',
            ]
            # non-scaling-stroke keeps the same fine outline at every map zoom.
            svg.extend(f'<path vector-effect="non-scaling-stroke" d="{path}"/>' for path in outlines)
            svg.append('</g><g fill="#a6cee3" fill-rule="evenodd">')
            svg.extend(f'<path d="{path}"/>' for path in water)
            svg.append("</g></svg>\n")
            target = output / f"{column}-{row}.svg"
            target.write_text("".join(svg), encoding="utf-8")
            total_bytes += target.stat().st_size
    print(f"Generated {COLUMNS * ROWS} SVG tiles ({total_bytes:,} bytes) in {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Path to packaged_data.gpkg")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "design-map-tiles")
    args = parser.parse_args()
    generate(args.source, args.output)
