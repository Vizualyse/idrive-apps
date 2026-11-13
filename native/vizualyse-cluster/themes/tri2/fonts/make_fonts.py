# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
# Static instances of Archivo (SIL OFL 1.1, OFL.txt) for the glyph atlases:
# the atlas builder sets a weight but not a width, so each width the mockup
# uses is cut as its own font. The art uses the variable font itself.
#   python themes/tri2/fonts/make_fonts.py
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
CUTS = {                       # name: (wght, wdth)
    'num': (560, 108),         # the power total and the speed
    'gear': (600, 104),        # the gear numeral
    'val': (560, 105),         # tyre psi, column values, power rows
    'small': (460, 96),        # meta line, labels, column subs, tyre temps
    'tc': (600, 80),           # tyre flags; Comfort's zone labels
    'sign': (700, 92),         # Comfort's speed limit sign
}
for name, (wght, wdth) in CUTS.items():
    f = TTFont(os.path.join(HERE, 'Archivo-latin.woff2'))
    inst = instancer.instantiateVariableFont(f, {'wght': wght, 'wdth': wdth})
    inst.flavor = 'woff2'
    inst.save(os.path.join(HERE, 'Archivo-%s.woff2' % name))
    print(name, wght, wdth)
