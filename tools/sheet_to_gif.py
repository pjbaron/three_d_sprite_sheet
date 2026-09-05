"""
Build an animated GIF from a sprite sheet PNG plus its capture JSON.

The JSON carries the cell grid, the per-frame anchor, the source frame times
and the root travel the anchor lock removed, so playback here matches what the
tool's own preview shows.

Only the sheet PNG is required.  The capture JSON and the output GIF are named
after it unless you say otherwise, so both of these do the same thing:

    python tools/sheet_to_gif.py walk_8x2_bonemap.png
    python tools/sheet_to_gif.py walk_8x2_bonemap.png walk_8x2.json walk_8x2_bonemap.gif

More examples:

    python tools/sheet_to_gif.py walk_8x2.png --height 220
    python tools/sheet_to_gif.py walk_8x2.png --travel --bg #202024 --fps 15

Without --travel the figure is anchor-locked in place; with it, the root
motion the anchor lock removed is replayed and the canvas widens to fit
the whole path.
"""
import argparse
import glob
import json
import os
import sys

from PIL import Image


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('sheet',
                   help='sprite sheet PNG, e.g. walk_8x2_bonemap.png')
    p.add_argument('meta', nargs='?', default='',
                   help='capture JSON, e.g. walk_8x2.json '
                        '(default: the sheet name with .json)')
    p.add_argument('out', nargs='?', default='',
                   help='GIF to write, e.g. walk_8x2_bonemap.gif '
                        '(default: the sheet name with .gif)')
    p.add_argument('--height', type=int, default=0, metavar='PIXELS',
                   help='scale cells to this pixel height, e.g. --height 256')
    p.add_argument('--travel', action='store_true',
                   help='replay the removed root motion')
    p.add_argument('--bg', default='', metavar='#RRGGBB',
                   help='flatten onto this colour, e.g. --bg #202024')
    p.add_argument('--fps', type=float, default=0.0, metavar='RATE',
                   help='override playback rate, e.g. --fps 15')
    if not argv:
        p.print_usage()
        print(no_sheet_hint())
        raise SystemExit(2)
    check_dashes(argv, p)
    return p.parse_args(argv)


LONG_OPTIONS = ('height', 'travel', 'bg', 'fps', 'help')


def check_dashes(argv, parser):
    """Catch -height / -fps / '-h 256', which argparse would silently read as -h."""
    for i, tok in enumerate(argv):
        name = tok.lstrip('-').split('=')[0]
        if tok.startswith('--') or not tok.startswith('-'):
            continue
        if name in LONG_OPTIONS and name != 'h':
            parser.print_usage()
            raise SystemExit('%s needs two dashes: --%s' % (tok, name))
        if tok == '-h' and i + 1 < len(argv) and not argv[i + 1].startswith('-'):
            parser.print_usage()
            raise SystemExit('-h means help, not height.  For height use: --height %s'
                             % argv[i + 1])


def sheets_here():
    """Sprite sheet PNGs sitting next to the JSON that describes them."""
    found = []
    for png in sorted(glob.glob('*.png') + glob.glob('*/*.png')):
        if os.path.exists(meta_for(png)):
            found.append(png)
    return found


def no_sheet_hint():
    found = sheets_here()
    if not found:
        return ('\nYou need to name a sprite sheet PNG.  The capture JSON and the\n'
                'output GIF are named after it, so one argument is usually enough:\n'
                '    python tools/sheet_to_gif.py walk_8x2_bonemap.png\n'
                'No sheet PNG with a matching JSON was found in this directory.')
    lines = ['\nSheets found here, pick one:']
    lines += ['    python %s %s' % (sys.argv[0], name) for name in found[:8]]
    lines.append('Run with --help for the scaling, travel and colour options.')
    return '\n'.join(lines)


def meta_for(sheet):
    """The capture JSON that goes with a sheet: drop _bonemap, swap the suffix."""
    stem = os.path.splitext(sheet)[0]
    if stem.endswith('_bonemap'):
        stem = stem[:-len('_bonemap')]
    return stem + '.json'


def resolve_paths(args):
    if not os.path.exists(args.sheet):
        near = [n for n in sheets_here()
                if os.path.basename(n).replace('_', '') ==
                os.path.basename(args.sheet).replace('_', '')]
        hint = ('\nDid you mean %s ?' % near[0]) if near else no_sheet_hint()
        raise SystemExit('sheet PNG not found: %s%s' % (args.sheet, hint))

    if not args.meta:
        args.meta = meta_for(args.sheet)
        if not os.path.exists(args.meta):
            raise SystemExit(
                'no capture JSON found for %s.\n'
                'Expected %s next to it.  Name the JSON yourself if it lives elsewhere:\n'
                '    python %s %s path/to/capture.json'
                % (args.sheet, args.meta, sys.argv[0], args.sheet))
        print('using capture JSON %s' % args.meta)
    elif not os.path.exists(args.meta):
        raise SystemExit('capture JSON not found: %s' % args.meta)

    if not args.out:
        args.out = os.path.splitext(args.sheet)[0] + '.gif'
        print('writing %s' % args.out)
    return args


def rgb(text):
    text = text.lstrip('#')
    if len(text) != 6:
        raise ValueError('--bg wants six hex digits, got %r' % text)
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def frame_durations_ms(meta, fps_override):
    """Per-frame display time, in milliseconds, from the source frame times."""
    times = [f['timeSeconds'] for f in meta['frames']]
    if len(times) == 1:
        return [1000]
    steps = [times[i + 1] - times[i] for i in range(len(times) - 1)]
    steps.append(steps[0] if meta['source']['loops'] else steps[-1])
    if fps_override:
        steps = [1.0 / fps_override] * len(steps)
    if min(steps) <= 0:
        raise ValueError('non-increasing frame times in %s' % meta.get('clip'))
    # GIF stores delays in hundredths of a second, so quantise there.
    return [max(20, int(round(s * 100)) * 10) for s in steps]


def placements(meta, travel):
    """Top-left position of every cell on the output canvas, and its size."""
    cw, ch = meta['cell']['width'], meta['cell']['height']
    if not travel:
        return [(0, 0)] * len(meta['frames']), cw, ch

    # destX = targetX - anchor.x + rootOffsetPx.x, per the JSON's playback note.
    raw = [(-f['anchor']['x'] + f['rootOffsetPx']['x'],
            -f['anchor']['y'] + f['rootOffsetPx']['y']) for f in meta['frames']]
    minx = min(x for x, _ in raw)
    miny = min(y for _, y in raw)
    width = int(round(max(x for x, _ in raw) - minx)) + cw
    height = int(round(max(y for _, y in raw) - miny)) + ch
    return [(int(round(x - minx)), int(round(y - miny))) for x, y in raw], width, height


def build_frames(sheet, meta, args):
    cw, ch = meta['cell']['width'], meta['cell']['height']
    if sheet.size != (meta['sheet']['width'], meta['sheet']['height']):
        raise ValueError('sheet is %dx%d but the JSON describes %dx%d'
                         % (sheet.size + (meta['sheet']['width'], meta['sheet']['height'])))

    spots, canvas_w, canvas_h = placements(meta, args.travel)
    scale = args.height / ch if args.height else 1.0

    out = []
    for f, (px, py) in zip(meta['frames'], spots):
        cell = sheet.crop((f['cell']['x'], f['cell']['y'],
                           f['cell']['x'] + cw, f['cell']['y'] + ch))
        canvas = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
        canvas.paste(cell, (px, py))
        if scale != 1.0:
            canvas = canvas.resize((max(1, int(round(canvas_w * scale))),
                                   max(1, int(round(canvas_h * scale)))),
                                  Image.LANCZOS)
        out.append(canvas)
    return out


def flatten(frames, colour):
    out = []
    for f in frames:
        bg = Image.new('RGBA', f.size, colour + (255,))
        bg.alpha_composite(f)
        out.append(bg.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=255))
    return out


def keep_alpha(frames):
    """Quantise to 255 colours and reserve index 255 for the transparent pixels."""
    out = []
    for f in frames:
        mask = f.getchannel('A').point(lambda a: 255 if a < 128 else 0)
        p = f.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=255)
        p.paste(255, mask)
        out.append(p)
    return out


def main(argv):
    args = resolve_paths(parse_args(argv))
    meta = json.load(open(args.meta, encoding='utf-8'))
    if meta.get('generator') != 'three_d_sprite_sheet':
        raise SystemExit('%s is not a capture JSON written by this tool '
                         '(no "generator": "three_d_sprite_sheet" key)' % args.meta)

    sheet = Image.open(args.sheet).convert('RGBA')
    frames = build_frames(sheet, meta, args)
    delays = frame_durations_ms(meta, args.fps)

    if args.bg:
        frames = flatten(frames, rgb(args.bg))
        extra = {}
    else:
        frames = keep_alpha(frames)
        extra = {'transparency': 255, 'disposal': 2}

    frames[0].save(args.out, save_all=True, append_images=frames[1:],
                   duration=delays, loop=0, optimize=False, **extra)
    print('%s: %d frames, %dx%d, %d ms total'
          % (args.out, len(frames), frames[0].width, frames[0].height, sum(delays)))


if __name__ == '__main__':
    main(sys.argv[1:])
