"""
Build an animated GIF from a sprite sheet PNG plus its capture JSON.

The JSON carries the cell grid, the per-frame anchor, the source frame times
and the root travel the anchor lock removed, so playback here matches what the
tool's own preview shows.

    python tools/sheet_to_gif.py sheet.png sheet.json out.gif
    python tools/sheet_to_gif.py sheet.png sheet.json out.gif --height 220 --travel

Options:
    --height N     scale every frame so the cell is N pixels tall
    --travel       replay the root motion the anchor lock removed, widening
                   the canvas to fit the whole path (default: figure locked)
    --bg #RRGGBB   flatten onto this colour instead of keeping transparency
    --fps N        override the playback rate taken from the JSON
"""
import argparse
import json
import sys

from PIL import Image


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('sheet', help='sprite sheet PNG (beauty or bone map)')
    p.add_argument('meta', help='capture JSON that goes with the sheet')
    p.add_argument('out', help='GIF to write')
    p.add_argument('--height', type=int, default=0, help='scale cells to this pixel height')
    p.add_argument('--travel', action='store_true', help='replay the removed root motion')
    p.add_argument('--bg', default='', help='flatten onto this colour, e.g. #202024')
    p.add_argument('--fps', type=float, default=0.0, help='override playback rate')
    return p.parse_args(argv)


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
    args = parse_args(argv)
    meta = json.load(open(args.meta, encoding='utf-8'))
    if meta.get('generator') != 'three_d_sprite_sheet':
        raise ValueError('%s is not a sheet JSON from this tool' % args.meta)

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
