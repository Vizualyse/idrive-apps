# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
"""
The perf1 family's fonts: Archivo (OFL), the variable subset the mockup
embeds (Archivo-subset-VF.woff2, used as it is by art.html), cut into the
static instances the glyph atlases need (theme_build.js's atlas page sets a
weight but no width), and the metrics the gen script lays text out with:

  Archivo-600-108.woff2   readings: SemiBold, 108% wide (the mockup's .num)
  Archivo-500-100.woff2   units and the battery state word (.unit, .lab)
  metrics.json            per instance: units per em, ascent, descent and
                          each character's advance (digits tabular), so
                          gen.js and logic.js place glyphs as Chrome does

  python themes/perf1/fonts/fonts.py        (needs fontTools and brotli)
"""
import json
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
VF = os.path.join(HERE, 'Archivo-subset-VF.woff2')
INSTANCES = {'600-108': {'wght': 600, 'wdth': 108}, '500-100': {'wght': 500, 'wdth': 100}}


def tnum_map(font):
    """glyph -> its tabular form, from the GSUB 'tnum' single substitutions"""
    out = {}
    gsub = font['GSUB'].table
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag != 'tnum':
            continue
        for li in fr.Feature.LookupListIndex:
            for st in gsub.LookupList.Lookup[li].SubTable:
                st = getattr(st, 'ExtSubTable', st)
                if hasattr(st, 'mapping'):
                    out.update(st.mapping)
    return out


def main():
    metrics = {}
    for name, axes in INSTANCES.items():
        f = instancer.instantiateVariableFont(TTFont(VF), axes)
        f.flavor = 'woff2'
        f.save(os.path.join(HERE, 'Archivo-' + name + '.woff2'))
        f = TTFont(os.path.join(HERE, 'Archivo-' + name + '.woff2'))
        cmap, hmtx, tn = f.getBestCmap(), f['hmtx'], tnum_map(f)
        adv = {}
        for cp, g in cmap.items():
            c = chr(cp)
            adv[c] = hmtx[tn.get(g, g) if c.isdigit() else g][0]
        os2 = f['OS/2']
        metrics[name] = {'upm': f['head'].unitsPerEm, 'asc': os2.sTypoAscender, 'desc': -os2.sTypoDescender, 'adv': adv}
    with open(os.path.join(HERE, 'metrics.json'), 'w', encoding='utf-8') as fp:
        json.dump(metrics, fp, ensure_ascii=False, indent=1, sort_keys=True)
    print('wrote', ', '.join('Archivo-' + n + '.woff2' for n in INSTANCES), 'and metrics.json')


if __name__ == '__main__':
    main()
