#!/usr/bin/env python3
"""Developer tool (not part of the build): regenerates extension/icons/ (SVG sources + PNG 16/32/48/96/128) for Term Sherpa.
Needs Pillow (pip install pillow). Run from prototype/:  python3 scripts/make-icons.py [output-dir]
Geometry is the designer-approved concept A on a 128 grid: rounded tile (radius 28, #BFDDF5), mountain triangle (#1F4E79) edge to edge
on the bottom with its peak 22px from the top, white jagged snowcap on the top of the peak, white dashed S-shaped trail (4px) at 48px and up.
At 96 and 128 the snowcap is a little bigger and more jagged (designer's polish); 16, 32 and 48 keep the approved cap."""
import math, os, sys
from PIL import Image, ImageDraw

SKY = (0xBF, 0xDD, 0xF5, 255); MTN = (0x1F, 0x4E, 0x79, 255); W = (255, 255, 255, 255)
T, L, R, B = 22, 0, 128, 128
P0, P1, P2 = (34, 124), (96, 110), (30, 72)

def cap_points(size):
    """Snowcap polygon on the 128 grid (list of points) and the y of its lower edge."""
    if size >= 96:  # bigger and more jagged
        capH = 0.27 * (B - T); cy = T + capH; hw = capH * 64 / (B - T)
        pts = [(64, T), (64 + hw, cy), (64 + hw * 0.66, cy - 7), (64 + hw * 0.40, cy + 2), (64 + hw * 0.12, cy - 9),
               (64 - hw * 0.14, cy + 3), (64 - hw * 0.42, cy - 7), (64 - hw * 0.68, cy + 1), (64 - hw, cy)]
    else:  # approved
        capH = 0.2 * (B - T) + (6 if size <= 16 else 0); cy = T + capH; hw = capH * 64 / (B - T)
        pts = [(64, T), (64 + hw, cy), (64 + hw * 0.5, cy - 5), (64 + hw * 0.15, cy + 1), (64 - hw * 0.25, cy - 5), (64 - hw * 0.6, cy - 1), (64 - hw, cy)]
    return pts, cy

def trail(cy):
    p3 = (64, cy + 4)
    def bez(t):
        u = 1 - t
        return tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * e for a, b, c, e in zip(P0, P1, P2, p3))
    return p3, bez

def draw_png(size, dashes):
    S = 8; n = 128 * S; im = Image.new('RGBA', (n, n), SKY); d = ImageDraw.Draw(im); k = lambda v: int(v * S)
    d.polygon([(k(L), k(B)), (k(R), k(B)), (k(64), k(T))], fill=MTN)
    pts, cy = cap_points(size)
    d.polygon([(k(x), k(y)) for x, y in pts], fill=W)
    if dashes:
        _, bez = trail(cy)
        line = [bez(i / 2000) for i in range(2001)]
        cum = [0]
        for a, b in zip(line, line[1:]): cum.append(cum[-1] + math.dist(a, b))
        dl = cum[-1] / (dashes * 2 - 1)
        for i in range(dashes):
            s, e = 2 * i * dl, 2 * i * dl + dl
            seg = [line[j] for j in range(len(line)) if s <= cum[j] <= e]
            d.line([(k(x), k(y)) for x, y in seg], fill=W, width=k(4), joint='curve')
            for x, y in (seg[0], seg[-1]): d.ellipse([k(x - 2), k(y - 2), k(x + 2), k(y + 2)], fill=W)
    mask = Image.new('L', (n, n), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=k(28), fill=255)
    im.putalpha(mask)
    return im.resize((size, size), Image.LANCZOS)

def f(v): return ('%.2f' % v).rstrip('0').rstrip('.')

def svg(size, dashes):
    pts, cy = cap_points(size)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">',
           '  <title>Term Sherpa</title>',
           '  <clipPath id="tile"><rect width="128" height="128" rx="28" ry="28"/></clipPath>',
           '  <g clip-path="url(#tile)">',
           '    <rect width="128" height="128" fill="#BFDDF5"/>',
           '    <polygon points="0,128 128,128 64,22" fill="#1F4E79"/>',
           '    <polygon points="' + ' '.join(f(x) + ',' + f(y) for x, y in pts) + '" fill="#FFFFFF"/>']
    if dashes:
        p3, bez = trail(cy)
        line = [bez(i / 2000) for i in range(2001)]
        total = sum(math.dist(a, b) for a, b in zip(line, line[1:])); dl = total / (dashes * 2 - 1)
        out.append('    <path d="M%s,%s C%s,%s %s,%s %s,%s" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-dasharray="%s %s"/>' % (
            f(P0[0]), f(P0[1]), f(P1[0]), f(P1[1]), f(P2[0]), f(P2[1]), f(p3[0]), f(p3[1]), f(dl), f(dl)))
    out += ['  </g>', '</svg>', '']
    return '\n'.join(out)

if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension', 'icons')
    os.makedirs(outdir, exist_ok=True)
    sizes = {16: 0, 32: 0, 48: 7, 96: 9, 128: 9}
    for s, dsh in sizes.items(): draw_png(s, dsh).save(os.path.join(outdir, 'icon-%d.png' % s), optimize=True)
    for name, (s, dsh) in {'icon.svg': (128, 9), 'icon-48.svg': (48, 7), 'icon-small.svg': (32, 0)}.items():
        open(os.path.join(outdir, name), 'w').write(svg(s, dsh))
    print('wrote icons to', os.path.abspath(outdir))
