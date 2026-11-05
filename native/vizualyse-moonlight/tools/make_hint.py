# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""The stop hint, drawn once at build time (build.sh, in the build image):
white DejaVu Sans Bold on a rounded, half-transparent black box, as
premultiplied RGBA for an mgu-render IMAGE (at most 1024 x 1024). Sized for
the 1920x720 centre screen, where it is drawn 1:1 at the bottom centre.

    python3 make_hint.py <font.ttf> <out.rgba>

out.rgba: "MLHI", u32 LE width, u32 LE height, then width*height*4 bytes.
"""
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

LINES = ["To stop: hold the screen for 2 s",
         "or hold Start + Back + LB + RB, or Stop on the phone"]
SIZE = 28          # px: the old burnt-in hint's, on the 720 px high screen
PAD_X, PAD_Y, GAP = 28, 14, 8
BOX_ALPHA = 160


def main(font_path, out_path):
    font = ImageFont.truetype(font_path, SIZE)
    sizes = [font.getsize(t) for t in LINES]
    line_h = max(h for _, h in sizes)
    w = max(tw for tw, _ in sizes) + 2 * PAD_X
    h = len(LINES) * line_h + (len(LINES) - 1) * GAP + 2 * PAD_Y
    w += w & 1
    h += h & 1
    assert w <= 1024 and h <= 1024, (w, h)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Pillow 5 (Ubuntu 18.04) has no rounded_rectangle: a box and four circles
    r = min(16, h // 3)
    box = (0, 0, 0, BOX_ALPHA)
    d.rectangle([r, 0, w - 1 - r, h - 1], fill=box)
    d.rectangle([0, r, w - 1, h - 1 - r], fill=box)
    for cx, cy in ((r, r), (w - 1 - r, r), (r, h - 1 - r), (w - 1 - r, h - 1 - r)):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=box)
    text = Image.new("L", (w, h), 0)
    td = ImageDraw.Draw(text)
    y = PAD_Y
    for t, (tw, _) in zip(LINES, sizes):
        td.text(((w - tw) // 2, y), t, font=font, fill=255)
        y += line_h + GAP
    out = bytearray(w * h * 4)
    px, tx = img.load(), text.load()
    for yy in range(h):
        for xx in range(w):
            a_box = px[xx, yy][3] / 255.0
            a_txt = tx[xx, yy] / 255.0
            a = a_txt + a_box * (1 - a_txt)          # white over the box
            c = int(round(255 * a_txt))              # premultiplied white
            i = (yy * w + xx) * 4
            out[i:i + 4] = bytes((c, c, c, int(round(255 * a))))
    with open(out_path, "wb") as f:
        f.write(b"MLHI" + struct.pack("<II", w, h) + bytes(out))
    print("hint: %dx%d" % (w, h))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
