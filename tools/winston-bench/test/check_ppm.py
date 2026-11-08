#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""Checks a picture of the centre screen (P6 PPM, kms_shim's grab) for
wo_bench's test pattern: four quadrants red, green, blue, white of a WxH
picture, fitted (aspect kept, centred) into the place X,Y,PW,PH.

  check_ppm.py FILE shown   WxH X,Y,PW,PH   the pattern is there, where it should be
  check_ppm.py FILE absent  WxH X,Y,PW,PH   it isn't
Exit 0 when it holds; says what it saw."""
import sys


def read_ppm(path):
    data = open(path, 'rb').read()
    parts = data.split(b'\n', 3)
    assert parts[0] == b'P6', 'not a P6 PPM'
    w, h = map(int, parts[1].split())
    return w, h, parts[3]


def main():
    path, mode, size, place = sys.argv[1:5]
    bw, bh = map(int, size.split('x'))
    x, y, pw, ph = map(int, place.split(','))
    w, h, px = read_ppm(path)
    # where the picture lands: fitted into the place, centred
    dw, dh = pw, pw * bh // bw
    if dh > ph:
        dh, dw = ph, ph * bw // bh
    dx, dy = x + (pw - dw) // 2, y + (ph - dh) // 2

    def at(sx, sy):
        i = (sy * w + sx) * 3
        return tuple(px[i:i + 3])

    want = {'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255), 'white': (255, 255, 255)}
    probes = [('red', 0.25, 0.25), ('green', 0.75, 0.25), ('blue', 0.25, 0.75), ('white', 0.6, 0.6)]
    seen = []
    ok = 0
    for name, fx, fy in probes:
        sx, sy = int(dx + fx * dw), int(dy + fy * dh)
        c = at(sx, sy)
        seen.append('%s@%d,%d=%s' % (name, sx, sy, c))
        ok += all(abs(a - b) <= 8 for a, b in zip(c, want[name]))
    # the edges: just inside is the picture, just outside is not (where there is room)
    edges = 0
    if dx > 0:
        inside, outside = at(dx + 2, dy + dh // 4), at(dx - 3, dy + dh // 4)
        edges += inside[0] > 200 and inside[1] < 50 and not (outside[0] > 200 and outside[1] < 50)
        seen.append('left edge x=%d in=%s out=%s' % (dx, inside, outside))
    else:
        edges += 1
    print('picture %dx%d at %d,%d %dx%d; %s' % (bw, bh, dx, dy, dw, dh, '; '.join(seen)))
    if mode == 'shown':
        good = ok == len(probes) and edges == 1
    else:
        good = ok == 0
    print('ok' if good else 'FAILED (%s)' % mode)
    return 0 if good else 1


if __name__ == '__main__':
    sys.exit(main())
