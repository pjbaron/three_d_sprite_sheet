"""
Render docs/bone_legend.png from the palette in js/boneColor.js.

The README shows the legend so nobody has to open the tool to decode a bone
map. Regenerate it after changing a colour:

    python tools/make_bone_legend.py
"""
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "js" / "boneColor.js"
OUT = ROOT / "docs" / "bone_legend.png"

# Left and right side by side, so the mirrored pairs read across the row and
# each limb's warm/cool ramp reads down it.
COLUMNS = [
    ("centre", ["head", "torso", "unmatched"]),
    ("left", ["shoulder.L", "upperarm.L", "forearm.L", "hand.L",
              "thigh.L", "shin.L", "foot.L"]),
    ("right", ["shoulder.R", "upperarm.R", "forearm.R", "hand.R",
               "thigh.R", "shin.R", "foot.R"]),
]

ROW_H, COL_W, PAD, SWATCH = 40, 300, 22, 26
BG = (30, 31, 38)
EDGE = (70, 72, 82)
LABEL = (226, 228, 235)
VALUE = (140, 144, 158)
HEADING = (120, 124, 140)


def read_palette():
    """Label -> #RRGGBB, taken straight from the REGIONS table."""
    src = io.open(SOURCE, encoding="utf-8").read()
    regions = src.split("REGIONS:", 1)[1].split("UNMATCHED", 1)[0]

    out = {}
    for m in re.finditer(r"color:\s*\[([^\]]+)\][^\n]*?label:\s*'([^']+)'", regions):
        rgb = tuple(float(x) for x in m.group(1).split(","))
        label = m.group(2)
        # Every label appears once per rig convention; the colours must agree.
        if label in out and out[label] != rgb:
            raise ValueError("rig conventions disagree on %s: %s vs %s"
                             % (label, out[label], rgb))
        out[label] = rgb

    unmatched = re.search(r"UNMATCHED:\s*\[([^\]]+)\]", src)
    if not unmatched:
        raise ValueError("no UNMATCHED colour in %s" % SOURCE)
    out["unmatched"] = tuple(float(x) for x in unmatched.group(1).split(","))

    return {k: "#%02X%02X%02X" % tuple(round(c * 255) for c in v)
            for k, v in out.items()}


def main():
    palette = read_palette()
    listed = sorted(n for _, names in COLUMNS for n in names)
    if listed != sorted(palette):
        raise ValueError("legend layout is out of step with the palette: %s"
                         % json.dumps({"layout": listed, "palette": sorted(palette)}))

    font = ImageFont.truetype("consola.ttf", 20)
    bold = ImageFont.truetype("consolab.ttf", 18)

    rows = max(len(names) for _, names in COLUMNS)
    img = Image.new("RGB", (PAD * 2 + COL_W * len(COLUMNS),
                            PAD * 2 + ROW_H * (rows + 1)), BG)
    d = ImageDraw.Draw(img)

    for ci, (title, names) in enumerate(COLUMNS):
        x = PAD + ci * COL_W
        d.text((x, PAD + 4), title.upper(), font=bold, fill=HEADING)
        for ri, name in enumerate(names):
            y = PAD + ROW_H * (ri + 1)
            value = palette[name]
            rgb = tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))
            d.rectangle([x, y, x + SWATCH, y + SWATCH], fill=rgb, outline=EDGE)
            d.text((x + SWATCH + 12, y + 3), name, font=font, fill=LABEL)
            d.text((x + SWATCH + 164, y + 3), value, font=font, fill=VALUE)

    img.save(OUT)
    print("%s: %dx%d, %d entries" % (OUT, img.width, img.height, len(palette)))


if __name__ == "__main__":
    main()
