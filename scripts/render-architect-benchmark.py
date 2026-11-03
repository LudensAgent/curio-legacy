"""Render benchmark blueprints, not game screenshots. Requires Pillow.

Usage: python scripts/render-architect-benchmark.py <results-directory> [--blind] [--individual-only]
Input: one JSON record per call, with evaluation.cells containing compiled blocks.
Outputs: <id>.png and contact-<scenario>[-rN].png in the same directory.
Blind mode renders only valid designs into blind/ with a separate mapping.json.
"""

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


BACKGROUND = "#f3f1e9"
INK = "#26343a"
EFFORTS = ["off", "low", "high", "max"]
CAPS = [8192, 16384, 32768]
FLOWERS = {
    "dandelion": "#efc744", "poppy": "#c64738", "blue_orchid": "#74c7de",
    "allium": "#b681c9", "azure_bluet": "#e5e7de", "red_tulip": "#c84038",
    "orange_tulip": "#e69840", "white_tulip": "#f0eee8", "pink_tulip": "#e5a7b8",
    "oxeye_daisy": "#f0e7c3", "cornflower": "#567bc8", "lily_of_the_valley": "#f0f2e7",
    "wither_rose": "#45403b", "sunflower": "#efc744", "lilac": "#bd8ecb",
    "rose_bush": "#c44b52", "peony": "#db9bba", "torchflower": "#e8a33c",
    "pink_petals": "#e7b0c4",
}
GRASSES = {"grass", "short_grass", "tall_grass", "fern", "large_fern", "dead_bush"}
FONT_PATH = next((str(path) for path in [
    Path("C:/Windows/Fonts/msyh.ttc"),
    Path("C:/Windows/Fonts/segoeui.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
] if path.exists()), None)


def font(size):
    return ImageFont.truetype(FONT_PATH, size) if FONT_PATH else ImageFont.load_default()


def text_lines(draw, text, xy, max_width, size=19, fill=INK, max_lines=5):
    """Wrap both Chinese and Latin labels without assuming word boundaries."""
    x, y = xy
    lines, current = [], ""
    for character in str(text):
        if character == "\n" or draw.textlength(current + character, font=font(size)) > max_width:
            lines.append(current)
            current = "" if character == "\n" else character
        else:
            current += character
    if current:
        lines.append(current)
    for line in lines[:max_lines]:
        draw.text((x, y), line, font=font(size), fill=fill)
        y += size + 6
    return y


def material_color(name):
    wood = {
        "dark_oak": "#493322", "oak": "#b6925a", "spruce": "#735437",
        "birch": "#dcc794", "jungle": "#ad7854", "acacia": "#ba6639",
        "mangrove": "#823d39", "cherry": "#dfa6ad", "bamboo": "#c7ad54",
        "crimson": "#793a56", "warped": "#317b76",
    }
    colors = {
        "white": "#e4e4dd", "light_gray": "#a1a4a0", "gray": "#53595b",
        "black": "#282d32", "red": "#ae4135", "orange": "#d68132",
        "yellow": "#e3bd43", "lime": "#81ac3e", "green": "#57703b",
        "cyan": "#367b88", "light_blue": "#6da8cf", "blue": "#3f588e",
        "purple": "#785298", "magenta": "#b366a4", "pink": "#d998a5",
        "brown": "#79573a",
    }
    if "glass" in name:
        return "#9bd1da"
    if name.endswith("torch") or name.endswith("lantern"):
        return "#f1be51"
    if name in FLOWERS:
        return FLOWERS[name]
    if name == "flower_pot" or name.startswith("potted_"):
        return "#aa6c4e"
    if name in GRASSES or name.endswith("_sapling"):
        return "#8d744b" if name == "dead_bush" else "#78a653"
    if name in ["azalea", "flowering_azalea"]:
        return "#70904b"
    if name == "ladder":
        return "#a9834f"
    if name in ["crafting_table", "chest", "barrel"]:
        return "#9c6b32"
    if "furnace" in name or name == "smoker":
        return "#777d80"
    if "leaves" in name or "moss" in name or name == "grass_block":
        return "#688e4c"
    if "dirt" in name or name in ["podzol", "mud", "packed_mud"]:
        return "#826342"
    if "deepslate" in name or "blackstone" in name:
        return "#454950"
    if "sandstone" in name:
        return "#cdbb87"
    if "stone" in name or name in ["andesite", "tuff", "gravel"]:
        return "#92968f"
    if "quartz" in name or name == "calcite":
        return "#e1ddd2"
    if "brick" in name:
        return "#a16853"
    for prefix, color in wood.items():
        if name.startswith(prefix + "_") or name.startswith("stripped_" + prefix + "_"):
            if name.endswith(("_log", "_wood", "_stem", "_hyphae")):
                return shaded(color, .83 if name.startswith("stripped_") else .65)
            return color
    for prefix, color in colors.items():
        if name.startswith(prefix + "_"):
            return color
    digest = hashlib.sha256(name.encode()).digest()
    return tuple(80 + component % 110 for component in digest[:3])


def shaded(color, factor):
    rgb = Image.new("RGB", (1, 1), color).getpixel((0, 0))
    return tuple(round(min(255, channel * factor)) for channel in rgb)


def block_boxes(cell):
    """Approximate visible geometry; stair/slab state is retained, textures are not."""
    name, properties = cell["name"], cell.get("properties", {})
    full = (0, 0, 0, 1, 1, 1)
    if name.endswith("_slab"):
        slab_type = properties.get("type", "bottom")
        return [full] if slab_type == "double" else [(0, .5 if slab_type == "top" else 0, 0, 1, 1 if slab_type == "top" else .5, 1)]
    if name.endswith("_stairs"):
        top = properties.get("half") == "top"
        base = (0, .5 if top else 0, 0, 1, 1 if top else .5, 1)
        facing = properties.get("facing", "north")
        x0, x1 = (.5, 1) if facing == "east" else (0, .5) if facing == "west" else (0, 1)
        z0, z1 = (.5, 1) if facing == "south" else (0, .5) if facing == "north" else (0, 1)
        return [base, (x0, 0 if top else .5, z0, x1, .5 if top else 1, z1)]
    if name.endswith("_door"):
        along_x = properties.get("facing", "north") in ["north", "south"]
        if properties.get("open") in [True, "true"]:
            along_x = not along_x
        return [(0, 0, .42, 1, 1, .58)] if along_x else [(.42, 0, 0, .58, 1, 1)]
    if name.endswith("_trapdoor"):
        if properties.get("open") in [True, "true"]:
            return [(0, 0, .42, 1, 1, .58)]
        return [(0, .82 if properties.get("half") == "top" else 0, 0, 1, 1 if properties.get("half") == "top" else .18, 1)]
    if "glass_pane" in name or name == "iron_bars":
        return [(.44, 0, 0, .56, 1, 1), (0, 0, .44, 1, 1, .56)]
    if name.endswith("_fence") or name.endswith("_fence_gate"):
        return [(.35, 0, .35, .65, 1, .65), (0, .4, .43, 1, .55, .57), (0, .75, .43, 1, .9, .57)]
    if name.endswith("_wall"):
        return [(.25, 0, .25, .75, 1, .75), (0, 0, .35, 1, .8, .65)]
    if name.endswith("_carpet"):
        return [(0, 0, 0, 1, .0625, 1)]
    if name.endswith("torch"):
        return [(.43, 0, .43, .57, .65, .57)]
    if name.endswith("lantern"):
        return [(.25, 0, .25, .75, .65, .75)]
    if name == "ladder":
        front = [(.15, 0, .05, .25, 1, .15), (.75, 0, .05, .85, 1, .15)]
        front += [(.15, y, .05, .85, y + .09, .15) for y in [.15, .4, .65, .9]]
        facing = properties.get("facing", "south")
        if facing == "north":
            return [(x0, y0, 1-z1, x1, y1, 1-z0) for x0, y0, z0, x1, y1, z1 in front]
        if facing == "east":
            return [(z0, y0, x0, z1, y1, x1) for x0, y0, z0, x1, y1, z1 in front]
        if facing == "west":
            return [(1-z1, y0, x0, 1-z0, y1, x1) for x0, y0, z0, x1, y1, z1 in front]
        return front
    if name in ["chest", "ender_chest"]:
        return [(.06, 0, .06, .94, .6, .94), (.06, .63, .06, .94, .875, .94), (.44, .48, .02, .56, .74, .09)]
    if name == "flower_pot":
        return [(.3, 0, .3, .7, .45, .7)]
    if name.startswith("potted_"):
        return [(.3, 0, .3, .7, .4, .7), (.46, .4, .46, .54, .8, .54), (.32, .52, .45, .68, .59, .55), (.35, .74, .35, .65, .94, .65)]
    if name in FLOWERS:
        return [(.46, 0, .46, .54, .65, .54), (.25, .2, .45, .52, .29, .55), (.48, .35, .45, .75, .44, .55), (.3, .6, .3, .7, .82, .7)]
    if name in GRASSES:
        return [(.23, 0, .45, .31, .5, .55), (.46, 0, .45, .54, .72, .55), (.69, 0, .45, .77, .58, .55), (.45, 0, .23, .55, .48, .31), (.45, 0, .69, .55, .6, .77)]
    if name.endswith("_sapling"):
        return [(.46, 0, .46, .54, .55, .54), (.2, .36, .2, .8, .7, .8), (.32, .7, .32, .68, .9, .68)]
    if name in ["azalea", "flowering_azalea"]:
        bush = [(.4, 0, .4, .6, .45, .6), (.08, .3, .08, .92, .85, .92)]
        blossoms = [(.2, .84, .2, .36, .9, .36), (.62, .84, .5, .8, .9, .68), (.3, .84, .65, .46, .9, .81)]
        return bush + blossoms if name == "flowering_azalea" else bush
    return [full]


def draw_isometric(draw, cells, rect, view="north_east"):
    left, top, width, height = rect
    boxes = []
    for cell in cells:
        p = cell["pos"]
        name = cell["name"]
        for index, (x0, y0, z0, x1, y1, z1) in enumerate(block_boxes(cell)):
            color = material_color(name)
            if name in FLOWERS and index < 3 or name.startswith("potted_") and index in [1, 2]:
                color = "#78a653"
            elif name.startswith("potted_") and index == 3:
                color = FLOWERS.get(name.removeprefix("potted_"), "#78a653")
            elif name.endswith("_sapling") and index == 0:
                color = "#826342"
            elif name in ["azalea", "flowering_azalea"] and index == 0:
                color = "#826342"
            elif name == "flowering_azalea" and index >= 2:
                color = "#c194bb"
            elif name in ["chest", "ender_chest"] and index == 2:
                color = "#d9b64d"
            # Opposite views reveal both north/east and south/west elevations.
            bx0, bx1 = (p["x"] + x0, p["x"] + x1) if view == "north_east" else (-p["x"] - x1, -p["x"] - x0)
            bz0, bz1 = (-p["z"] - z1, -p["z"] - z0) if view == "north_east" else (p["z"] + z0, p["z"] + z1)
            boxes.append((bx0, p["y"] + y0, bz0,
                          bx1, p["y"] + y1, bz1,
                          color, name))
    if not boxes:
        return
    def project(x, y, z):
        return ((x - z) * math.sqrt(3) / 2, (x + z) * .5 - y)
    points = [project(x, y, z) for x0, y0, z0, x1, y1, z1, _, _ in boxes
              for x in [x0, x1] for y in [y0, y1] for z in [z0, z1]]
    min_x, max_x = min(p[0] for p in points), max(p[0] for p in points)
    min_y, max_y = min(p[1] for p in points), max(p[1] for p in points)
    # Use the scene's cuboid bounds rather than view-dependent silhouette bounds,
    # giving both cameras exactly the same scale even for asymmetric roofs.
    span_x = max(b[3] for b in boxes) - min(b[0] for b in boxes)
    span_z = max(b[5] for b in boxes) - min(b[2] for b in boxes)
    span_y = max(b[4] for b in boxes) - min(b[1] for b in boxes)
    scale = min((width - 32) / max(1, (span_x + span_z) * math.sqrt(3) / 2),
                (height - 32) / max(1, (span_x + span_z) * .5 + span_y))
    ox = left + width / 2 - (min_x + max_x) * scale / 2
    oy = top + height / 2 - (min_y + max_y) * scale / 2
    def screen(x, y, z):
        px, py = project(x, y, z)
        return (round(ox + px * scale), round(oy + py * scale))
    for x0, y0, z0, x1, y1, z1, color, name in sorted(boxes, key=lambda b: (b[0] + b[2], b[1])):
        faces = [
            ([(x1, y0, z0), (x1, y0, z1), (x1, y1, z1), (x1, y1, z0)], .74),
            ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], .88),
            ([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], 1.08),
        ]
        for vertices, shade in faces:
            polygon = [screen(*vertex) for vertex in vertices]
            draw.polygon(polygon, fill=shaded(color, shade), outline=shaded(color, .58))


def draw_section(draw, cells, y_level, rect):
    left, top, width, height = rect
    xs, zs = [c["pos"]["x"] for c in cells], [c["pos"]["z"] for c in cells]
    min_x, max_x, min_z, max_z = min(xs), max(xs), min(zs), max(zs)
    size = min(width / (max_x - min_x + 1), height / (max_z - min_z + 1))
    ox = left + (width - (max_x - min_x + 1) * size) / 2
    oy = top
    by_pos = {(c["pos"]["x"], c["pos"]["y"], c["pos"]["z"]): c for c in cells}
    for x in range(min_x, max_x + 1):
        for z in range(min_z, max_z + 1):
            cell = by_pos.get((x, y_level, z))
            floor = by_pos.get((x, -1, z))
            fill = material_color(cell["name"]) if cell else "#ece2cf" if floor else "#ffffff"
            x0, z0 = ox + (x - min_x) * size, oy + (z - min_z) * size
            draw.rectangle((x0, z0, x0 + size, z0 + size), fill=fill, outline="#b7b8b3")
            if cell and size >= 18:
                name = cell["name"]
                mark = "D" if name.endswith("_door") else "G" if "glass" in name else "C" if name in ["chest", "ender_chest"] else "F" if "furnace" in name else "W" if name == "crafting_table" else "H" if name == "ladder" else "*" if name in FLOWERS or name.startswith("potted_") else "L" if "lantern" in name or "torch" in name else "S" if name.endswith("_stairs") else ""
                if mark:
                    draw.text((x0 + size * .28, z0 + size * .08), mark, fill="#15252b", font=font(max(12, round(size * .55))))


def render_record(record, directory, blind_id=None):
    image = Image.new("RGB", (1600, 1060), BACKGROUND)
    draw = ImageDraw.Draw(image)
    evaluation = record.get("evaluation", {})
    cells = evaluation.get("cells", [])
    title = f"{blind_id} | {record['scenario']}" if blind_id else f"{record['scenario']} | {record['effort']} | max_tokens={record['maxTokens']} | r{record.get('replicate', 1)}"
    draw.text((34, 22), title, fill=INK, font=font(30))
    draw.text((34, 70), "Blueprint schematic - approximate block colors, no game textures or lighting", fill="#627079", font=font(19))
    if not cells:
        draw.text((50, 155), "No compilable blueprint", fill="#ad4a3f", font=font(35))
        text_lines(draw, evaluation.get("error") or record.get("error") or "No result", (50, 225), 1450, 24, max_lines=20)
    else:
        draw.rounded_rectangle((25, 115, 1120, 835), radius=18, fill="#ffffff")
        draw_isometric(draw, cells, (40, 130, 525, 675), "north_east")
        draw_isometric(draw, cells, (575, 130, 525, 675), "south_west")
        draw.text((48, 800), "North / east view", fill="#627079", font=font(18))
        draw.text((583, 800), "South / west view (same scale)", fill="#627079", font=font(18))
        draw.text((1160, 115), "Ground-level section (y=0)", fill=INK, font=font(20))
        draw_section(draw, cells, 0, (1160, 155, 400, 300))
        draw.text((1160, 500), "Head-level section (y=1)", fill=INK, font=font(20))
        draw_section(draw, cells, 1, (1160, 540, 400, 270))
        draw.text((1160, 822), "N up | pale cells: floor below", fill="#627079", font=font(16))
        draw.text((1160, 846), "D door / G glass / C chest", fill="#627079", font=font(16))
        draw.text((1160, 870), "F furnace / W workbench / L light", fill="#627079", font=font(16))
        draw.text((1160, 894), "H ladder / * flower or potted plant", fill="#627079", font=font(16))
        if not blind_id:
            stats = f"{evaluation.get('width', '?')} x {evaluation.get('depth', '?')} x {evaluation.get('height', '?')} | {len(cells)} blocks"
            draw.text((36, 865), stats, fill=INK, font=font(21))
            warnings = evaluation.get("warnings", [])
            text_lines(draw, "Compiler notes: " + ("; ".join(warnings) if warnings else "none"), (36, 902), 1080, 17, max_lines=3)
        palette = Counter(c["name"] for c in cells).most_common(12)
        for index, (name, count) in enumerate(palette):
            x, y = 36 + (index % 4) * 385, 985 + (index // 4) * 23
            draw.rectangle((x, y + 3, x + 15, y + 18), fill=material_color(name), outline="#657077")
            draw.text((x + 23, y), f"{name} ({count})", fill=INK, font=font(14))
    output = directory / f"{blind_id or record['id']}.png"
    image.save(output)
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--blind", action="store_true", help="Hide parameter labels and validation results; write blind/ and its mapping.json")
    parser.add_argument("--individual-only", action="store_true", help="Render individual blueprints without a parameter-grid contact sheet")
    args = parser.parse_args()
    records = []
    for path in sorted(args.directory.glob("*.json")):
        if path.name in ["manifest.json", "summary.json"]:
            continue
        record = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(record, dict) and all(key in record for key in ["id", "scenario", "effort", "maxTokens"]):
            records.append(record)
    if args.blind:
        directory = args.directory / "blind"
        directory.mkdir(exist_ok=True)
        valid = sorted((r for r in records if r.get("evaluation", {}).get("cells")),
                       key=lambda r: hashlib.sha256(r["id"].encode()).hexdigest())
        mapping = {f"B{index:02d}": {key: record.get(key) for key in ["id", "scenario", "effort", "maxTokens", "replicate"]}
                   for index, record in enumerate(valid, 1)}
        images = {blind_id: render_record(record, directory, blind_id)
                  for blind_id, record in zip(mapping, valid)}
        for scenario in ([] if args.individual_only else sorted({str(record["scenario"]) for record in valid})):
            blind_ids = [blind_id for blind_id, metadata in mapping.items() if str(metadata["scenario"]) == scenario]
            columns, tile_w, tile_h = 3, 720, 477
            contact = Image.new("RGB", (columns * tile_w + 40, math.ceil(len(blind_ids) / columns) * tile_h + 120), BACKGROUND)
            draw = ImageDraw.Draw(contact)
            draw.text((20, 15), f"{scenario} / blind blueprint review", font=font(30), fill=INK)
            draw.text((20, 59), "Stable ID-hash order. Approximate geometry and colors; not game screenshots.", font=font(18), fill="#627079")
            for index, blind_id in enumerate(blind_ids):
                left, top = 20 + (index % columns) * tile_w, 105 + (index // columns) * tile_h
                contact.paste(images[blind_id].resize((tile_w - 8, tile_h - 8), Image.Resampling.LANCZOS), (left, top))
            slug = re.sub(r"[^A-Za-z0-9_-]", "_", scenario)
            contact.save(directory / f"contact-{slug}.png")
        (directory / "mapping.json").write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Rendered {len(valid)} anonymous designs in {directory}; mapping.json is for unblinding only")
        return
    images = {record["id"]: render_record(record, args.directory) for record in records}
    if args.individual_only:
        print(f"Rendered {len(records)} individual blueprints in {args.directory}")
        return
    groups = sorted({(str(r["scenario"]), r.get("replicate", 1)) for r in records})
    for scenario, replicate in groups:
        caps = sorted(set(CAPS + [r["maxTokens"] for r in records if str(r["scenario"]) == scenario]))
        tile_w, tile_h = 720, 477
        contact = Image.new("RGB", (len(caps) * tile_w + 40, len(EFFORTS) * tile_h + 120), BACKGROUND)
        draw = ImageDraw.Draw(contact)
        draw.text((20, 15), f"{scenario} / replicate {replicate} / blueprint schematics", font=font(30), fill=INK)
        draw.text((20, 59), "Rows: off / low / high / max. Columns: output caps. No images are game screenshots.", font=font(18), fill="#627079")
        matching = {(r["effort"], r["maxTokens"]): r for r in records if str(r["scenario"]) == scenario and r.get("replicate", 1) == replicate}
        for row, effort in enumerate(EFFORTS):
            for column, cap in enumerate(caps):
                left, top = 20 + column * tile_w, 105 + row * tile_h
                record = matching.get((effort, cap))
                if record:
                    contact.paste(images[record["id"]].resize((tile_w - 8, tile_h - 8), Image.Resampling.LANCZOS), (left, top))
                else:
                    draw.rectangle((left, top, left + tile_w - 8, top + tile_h - 8), fill="#e7e7e1")
                    draw.text((left + 30, top + 35), f"{effort} / {cap}\nPending", fill="#6b7374", font=font(26))
        slug = re.sub(r"[^A-Za-z0-9_-]", "_", scenario)
        suffix = f"-r{replicate}" if replicate != 1 or any(r.get("replicate", 1) != 1 for r in records) else ""
        contact.save(args.directory / f"contact-{slug}{suffix}.png")
    print(f"Rendered {len(records)} records and {len(groups)} contact sheets in {args.directory}")


if __name__ == "__main__":
    main()
