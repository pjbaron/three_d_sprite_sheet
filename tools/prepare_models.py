"""
Scan models/ and regenerate js/catalog.js from what is actually there.

Reads each GLB's embedded glTF JSON (no dependencies, no decoding of mesh data)
and works out:

  - is it skinned, so it can be a character
  - does it carry animation, so it can be a clip
  - are its bone names Mixamo-shaped, so the bone-map palette and the
    name-based retargeting will actually work
  - which characters each clip can retarget onto

Curated display names already in catalog.js are preserved; only genuinely new
files get an auto-generated name.

    python tools/prepare_models.py            rewrite js/catalog.js and report
    python tools/prepare_models.py --check    report only, write nothing
    python tools/prepare_models.py --verbose  also list every unmatched bone name

Static analysis only - it says whether a file is shaped right, not whether
Babylon will like it. Load it in the tool to confirm.
"""

import argparse
import json
import re
import struct
import sys
from pathlib import Path

# This script lives in tools/, so the project root is one level up.
ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
CATALOG = ROOT / "js" / "catalog.js"
BONECOLOR = ROOT / "js" / "boneColor.js"
LOADER = ROOT / "js" / "loader.js"

# Mixamo's export convention: "Character@Animation.fbx". Such a file carries a
# copy of the mesh purely as a carrier for the animation, so it is a clip only.
ANIM_ONLY_MARKER = "@"

# Character exports often carry a single-key leftover animation. Anything this
# short is a stub, not something worth sampling into a sheet.
MIN_CLIP_SECONDS = 0.2

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942


# ---------------------------------------------------------------- GLB reading

def read_glb(path):
    """Return (gltf_json, bin_chunk_bytes) from a binary glTF file."""
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("file is too short to be a GLB")

    magic, version, total = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError("not a binary GLB (bad magic - is this a .gltf text file?)")
    if version != 2:
        raise ValueError(f"unsupported GLB version {version}, expected 2")

    gltf = None
    binary = b""
    offset = 12
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        body = data[offset + 8: offset + 8 + length]
        if kind == CHUNK_JSON:
            gltf = json.loads(body.decode("utf-8"))
        elif kind == CHUNK_BIN:
            binary = body
        offset += 8 + length + (-length % 4)

    if gltf is None:
        raise ValueError("no JSON chunk found in GLB")
    return gltf, binary


def accessor_max_float(gltf, binary, index):
    """Largest value of a scalar float accessor - used for clip length."""
    acc = gltf["accessors"][index]
    if acc.get("max"):
        return float(acc["max"][0])

    # No bounds recorded, so read the values. Animation inputs are always
    # non-sparse scalar floats, and sorted ascending, so the last one is the max.
    view = gltf["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride") or 4
    last = start + stride * (acc["count"] - 1)
    return struct.unpack_from("<f", binary, last)[0]


# ------------------------------------------------------- palette rules from JS

def load_palette_rules():
    """
    Pull the region regexes straight out of boneColor.js so this script cannot
    drift from the palette the tool actually uses.
    """
    src = BONECOLOR.read_text(encoding="utf-8")
    block = re.search(r"REGIONS:\s*\[(.*?)\n    \],", src, re.S)
    if not block:
        raise SystemExit(
            "Could not find the REGIONS array in js/boneColor.js. "
            "If its formatting changed, update load_palette_rules()."
        )

    rules = []
    for pattern, flags, label in re.findall(
        r"re:\s*/(.+?)/([a-z]*)\s*,.*?label:\s*'([^']+)'", block.group(1)
    ):
        opts = re.IGNORECASE if "i" in flags else 0
        rules.append((re.compile(pattern, opts), label))

    if not rules:
        raise SystemExit("Found the REGIONS array but parsed no rules out of it.")
    return rules


def load_anchor_patterns():
    """The centre-of-mass anchor candidates, read from loader.js for the same reason."""
    src = LOADER.read_text(encoding="utf-8")
    block = re.search(r"ANCHOR_PATTERNS:\s*\[(.*?)\n    \],", src, re.S)
    if not block:
        raise SystemExit(
            "Could not find ANCHOR_PATTERNS in js/loader.js. "
            "If its formatting changed, update load_anchor_patterns()."
        )
    out = []
    for pattern, flags in re.findall(r"/(.+?)/([a-z]*)\s*,", block.group(1)):
        out.append(re.compile(pattern, re.IGNORECASE if "i" in flags else 0))
    if not out:
        raise SystemExit("Found ANCHOR_PATTERNS but parsed no patterns out of it.")
    return out


def strip_prefix(name):
    return re.sub(r"^mixamorig[_:]?", "", name, flags=re.I)


# ------------------------------------------------------------------- analysis

class Model:
    def __init__(self, path):
        self.path = path
        self.file = path.name
        self.error = None

        self.joint_names = []
        self.animated_nodes = set()
        self.clips = []           # [(name, duration_seconds)]
        self.vertex_count = 0
        self.has_skin = False
        self.has_geometry = False
        self.anchor_bone = None
        self.unmatched_bones = []

        try:
            self._analyse()
        except Exception as exc:            # noqa: BLE001 - reported, not hidden
            self.error = str(exc)

    def _analyse(self):
        gltf, binary = read_glb(self.path)
        nodes = gltf.get("nodes", [])

        def node_name(i):
            return nodes[i].get("name", f"<node {i}>") if i < len(nodes) else f"<node {i}>"

        for skin in gltf.get("skins", []):
            self.has_skin = True
            for j in skin.get("joints", []):
                self.joint_names.append(node_name(j))

        for mesh in gltf.get("meshes", []):
            for prim in mesh.get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is not None:
                    self.has_geometry = True
                    self.vertex_count += gltf["accessors"][pos].get("count", 0)

        for anim in gltf.get("animations", []):
            duration = 0.0
            for chan in anim.get("channels", []):
                target = chan.get("target", {})
                if "node" in target:
                    self.animated_nodes.add(node_name(target["node"]))
            for sampler in anim.get("samplers", []):
                duration = max(duration, accessor_max_float(gltf, binary, sampler["input"]))
            self.clips.append((anim.get("name", "unnamed"), duration))

    # -- classification ---------------------------------------------------

    @property
    def is_anim_only(self):
        return ANIM_ONLY_MARKER in self.file

    @property
    def can_be_character(self):
        return bool(self.has_skin and self.has_geometry and not self.is_anim_only)

    @property
    def can_be_clip(self):
        return bool(self.clips)

    @property
    def identity(self):
        """Same mesh and skeleton means the same character wearing a different clip."""
        return (tuple(sorted(self.joint_names)), self.vertex_count)

    def check_bones(self, rules, anchor_patterns):
        bare = [strip_prefix(n) for n in self.joint_names]
        for rx in anchor_patterns:
            hit = next((n for n, b in zip(self.joint_names, bare) if rx.search(b)), None)
            if hit:
                self.anchor_bone = hit
                break
        self.unmatched_bones = [
            n for n, b in zip(self.joint_names, bare)
            if not any(rx.search(b) for rx, _ in rules)
        ]


# --------------------------------------------------------------- naming

def pretty_name(stem):
    """BikerIdle -> Biker Idle, road_worker_walk -> Road Worker Walk."""
    s = stem.replace("_", " ").replace("-", " ")
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return " ".join(w if w.isupper() else w[:1].upper() + w[1:] for w in s.split())


def make_id(stem, taken):
    base = re.sub(r"[^a-z0-9]+", "_", stem.lower()).strip("_") or "model"
    candidate = base
    n = 2
    while candidate in taken:
        candidate = f"{base}_{n}"
        n += 1
    taken.add(candidate)
    return candidate


def read_existing_catalog():
    """Map file name -> (id, display name) for entries already curated by hand."""
    if not CATALOG.exists():
        return {}, {}
    src = CATALOG.read_text(encoding="utf-8")

    def entries(array_name):
        block = re.search(rf"const {array_name} = \[(.*?)\n\];", src, re.S)
        if not block:
            return {}
        found = {}
        for line in block.group(1).splitlines():
            m = re.search(r"id:\s*'([^']*)'.*?name:\s*'([^']*)'.*?file:\s*(.+?),?\s*\}", line)
            if not m:
                continue
            file_expr = m.group(3).strip()
            # file may be written as ANIM_PREFIX + 'Name.glb'
            parts = re.findall(r"'([^']*)'", file_expr)
            prefix = ""
            if "ANIM_PREFIX" in file_expr:
                pm = re.search(r"const ANIM_PREFIX = '([^']*)'", src)
                prefix = pm.group(1) if pm else ""
            found[prefix + "".join(parts)] = (m.group(1), m.group(2))
        return found

    return entries("CHARACTERS"), entries("CLIPS")


# ---------------------------------------------------------------- generation

def js_string(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def render_catalog(characters, clips):
    def rows(items):
        if not items:
            return "    // nothing found\n"
        w_id = max(len(js_string(i["id"])) for i in items) + 1
        w_name = max(len(js_string(i["name"])) for i in items) + 1
        out = []
        for i in items:
            out.append(
                "    {{ id: {:<{wi}} name: {:<{wn}} file: {} }},".format(
                    js_string(i["id"]) + ",", js_string(i["name"]) + ",",
                    js_string(i["file"]), wi=w_id, wn=w_name,
                )
            )
        return "\n".join(out) + "\n"

    return f"""/**
 * Catalogue of characters and clips available to the sprite sheet tool.
 *
 * GENERATED by prepare_models.py - rerun it after adding or removing GLBs.
 * Display names are preserved across runs, so renaming an entry here sticks.
 *
 * A file listed in both arrays is self-contained: it carries its own mesh and
 * its own animation, and retargets onto itself.
 */
const MODEL_DIR = 'models/';

const CHARACTERS = [
{rows(characters)}];

const CLIPS = [
{rows(clips)}];
"""


# -------------------------------------------------------------------- report

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report only, do not write")
    ap.add_argument("--verbose", action="store_true", help="list every unmatched bone")
    args = ap.parse_args()

    if not MODELS_DIR.is_dir():
        raise SystemExit(f"No models directory at {MODELS_DIR}")

    rules = load_palette_rules()
    anchor_patterns = load_anchor_patterns()
    files = sorted(MODELS_DIR.glob("*.glb"), key=lambda p: p.name.lower())
    if not files:
        raise SystemExit(f"No .glb files in {MODELS_DIR}")

    models = []
    for path in files:
        m = Model(path)
        if not m.error:
            m.check_bones(rules, anchor_patterns)
        models.append(m)

    broken = [m for m in models if m.error]
    good = [m for m in models if not m.error]

    old_chars, old_clips = read_existing_catalog()
    taken_ids = set()

    # Characters: skip the Mixamo "@" carrier files, and keep only the first
    # file of each identical mesh+skeleton, since the rest are the same figure.
    characters = []
    seen_identity = {}
    duplicates = []
    for m in good:
        if not m.can_be_character:
            continue
        key = m.identity
        if key in seen_identity:
            duplicates.append((m, seen_identity[key]))
            continue
        seen_identity[key] = m
        stem = m.path.stem
        old = old_chars.get(m.file)
        entry_id = old[0] if old else make_id(stem, taken_ids)
        taken_ids.add(entry_id)
        characters.append({"id": entry_id, "name": old[1] if old else pretty_name(stem),
                           "file": m.file})

    taken_ids = set()
    clips = []
    for m in good:
        if not m.can_be_clip:
            continue
        stem = m.path.stem
        old = old_clips.get(m.file)
        entry_id = old[0] if old else make_id(stem, taken_ids)
        taken_ids.add(entry_id)
        if old:
            name = old[1]
        elif ANIM_ONLY_MARKER in stem:
            name = pretty_name(stem.split(ANIM_ONLY_MARKER, 1)[1])
        else:
            name = pretty_name(stem)
        clips.append({"id": entry_id, "name": name, "file": m.file})

    # -- retarget compatibility -------------------------------------------
    # Retargeting matches by bone name, so a clip only works on a character
    # whose skeleton uses the same names.
    char_models = {c["file"]: seen_identity[m.identity]
                   for c in characters for m in good if m.file == c["file"]}

    stubby = []
    incompatible = []
    for c in clips:
        clip_model = next(m for m in good if m.file == c["file"])
        targets = []
        for ch in characters:
            cm = char_models[ch["file"]]
            bare_joints = {strip_prefix(n) for n in cm.joint_names}
            hits = sum(1 for n in clip_model.animated_nodes
                       if strip_prefix(n) in bare_joints)
            if hits:
                targets.append((ch["name"], hits))
        if not targets:
            incompatible.append(c["name"])
        c["_targets"] = targets

    # -- print -------------------------------------------------------------
    print(f"Scanned {len(files)} GLB file(s) in {MODELS_DIR}\n")

    print(f"CHARACTERS ({len(characters)})")
    for c in characters:
        m = char_models[c["file"]]
        flags = []
        if not m.anchor_bone:
            flags.append("NO HIPS BONE - anchor falls back to the first bone")
        if m.unmatched_bones:
            flags.append(f"{len(m.unmatched_bones)} bone(s) unmatched by the palette")
        note = ("  <- " + "; ".join(flags)) if flags else ""
        print(f"  {c['name']:<22} {len(m.joint_names):>3} bones  "
              f"{m.vertex_count:>6} verts{note}")
        if args.verbose and m.unmatched_bones:
            print(f"      grey: {', '.join(m.unmatched_bones)}")

    print(f"\nCLIPS ({len(clips)})")
    for c in clips:
        m = next(x for x in good if x.file == c["file"])
        longest = max((d for _, d in m.clips), default=0.0)
        targets = c.pop("_targets")
        if len(targets) == len(characters):
            fit = "all characters"
        elif targets:
            fit = ", ".join(n for n, _ in targets)
        else:
            fit = "NO MATCHING CHARACTER - bone names differ"
        stub = "  <- too short to be a real clip" if longest < MIN_CLIP_SECONDS else ""
        if stub:
            stubby.append(c["name"])
        print(f"  {c['name']:<22} {longest:>5.2f}s  {len(m.animated_nodes):>3} nodes"
              f"  -> {fit}{stub}")

    if duplicates:
        print("\nSkipped as duplicate characters (same skeleton and mesh):")
        for dup, first in duplicates:
            print(f"  {dup.file}  ==  {first.file}")
        print("  Listed as clips only. Delete a line from CHARACTERS to change this.")

    if broken:
        print("\nCOULD NOT READ")
        for m in broken:
            print(f"  {m.file}: {m.error}")

    skipped = [m for m in good if not m.can_be_character and not m.can_be_clip]
    if skipped:
        print("\nNo skin and no animation, so not usable:")
        for m in skipped:
            print(f"  {m.file}")

    if stubby:
        print(f"\nWarning: {len(stubby)} clip(s) under {MIN_CLIP_SECONDS}s "
              f"({', '.join(stubby)}) - almost certainly leftover single-key "
              "animations from a character export. Delete those CLIPS lines.")

    if incompatible:
        print(f"\nWarning: {len(incompatible)} clip(s) match no character's bone names. "
              "Selecting one will throw rather than render.")

    # -- write -------------------------------------------------------------
    text = render_catalog(characters, clips)
    if args.check:
        current = CATALOG.read_text(encoding="utf-8") if CATALOG.exists() else ""
        print("\n" + ("catalog.js is up to date." if current == text
                      else "catalog.js is OUT OF DATE - rerun without --check."))
        return 0 if current == text else 1

    CATALOG.write_text(text, encoding="utf-8")
    print(f"\nWrote {CATALOG.relative_to(HERE)}: "
          f"{len(characters)} character(s), {len(clips)} clip(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
