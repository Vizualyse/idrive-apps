#!/usr/bin/env python3
"""Make an info-b.plist for hook111's trial files: view areas for the second
display's /info record, as a binary plist array [key, value, ...].

    python3 make_viewareas.py 936x480 x,y,w,h [x,y,w,h ...] info-b.plist
    python3 make_viewareas.py --empty info-b.plist      # no extra keys

One view area per safe area (x,y,w,h in the display's pixels); the view area
itself is the whole display. initialViewArea is 0. Copy the file to the unit's
/run/hook111/info-b.plist and "altScreen viewAreas" to /run/hook111/features;
the phone reads both when it next connects. The format is the one the Audi
MU0678 work found the phone accepts (joeyQuery/MHI2-altScreen,
src/gen2-audi/libaltscreen111_gen2.c, add_reference_viewarea).
Not shipped to the unit (component.json lists what is).
"""
import plistlib
import sys


def area(w, h, safe):
    x, y, sw, sh = safe
    if not (0 <= x and 0 <= y and sw > 0 and sh > 0 and x + sw <= w and y + sh <= h):
        raise ValueError("safe area %r is not inside %dx%d" % (safe, w, h))
    return {
        "widthPixels": w, "heightPixels": h, "originXPixels": 0, "originYPixels": 0,
        "drawUIOutsideSafeArea": False, "viewAreaTransitionControl": False,
        "safeArea": {"widthPixels": sw, "heightPixels": sh, "originXPixels": x, "originYPixels": y},
    }


def main(argv):
    if len(argv) == 3 and argv[1] == "--empty":
        pairs = []
        out = argv[2]
    else:
        if len(argv) < 4:
            sys.exit(__doc__)
        w, h = (int(v) for v in argv[1].split("x"))
        safes = [tuple(int(v) for v in s.split(",")) for s in argv[2:-1]]
        if any(len(s) != 4 for s in safes):
            sys.exit("a safe area is x,y,w,h")
        pairs = ["viewAreas", [area(w, h, s) for s in safes], "initialViewArea", 0]
        out = argv[-1]
    with open(out, "wb") as f:
        plistlib.dump(pairs, f, fmt=plistlib.FMT_BINARY)
    print("%s: %s" % (out, pairs))


if __name__ == "__main__":
    main(sys.argv)
