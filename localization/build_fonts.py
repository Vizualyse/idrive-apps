#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 小白151 (JackieZ123430)
"""Extend the upstream Latin atlases with the Chinese translation glyphs.
Requires Pillow and Noto Sans SC (SIL OFL 1.1). The original Latin metrics
and bitmaps are preserved. python localization/build_fonts.py --font FONT.ttf
"""
import argparse,gzip,json,math,pathlib,shutil
from PIL import Image,ImageDraw,ImageFont
from prepare import ROOT,HERE,CREDIT,dictionary

def main(font_path,license_path):
    out=HERE/'fonts';out.mkdir(exist_ok=True)
    src=ROOT/'platform/tool/touch_ui/1.0.0'
    meta=json.loads((src/'ui.fonts.json').read_text(encoding='utf-8'))
    all_text=''.join(dictionary().values())+CREDIT+'…：，（）／；、。%'
    for name, item in list(meta.items())+[('f14',{'file':'ui.f14.font.gz','size':14,'weight':500,'glyphs':'','cell':16,'lineH':16,'w':0,'h':14,'top':0,'adv':[]})]:
        f=dict(item)
        old=f['glyphs'];more=''.join(sorted(set(all_text+''.join(chr(i) for i in range(32,127)))-set(old)))
        font=ImageFont.truetype(str(font_path),f['size'])
        try:font.set_variation_by_axes([f['weight']])
        except (OSError,ValueError):pass
        # Some CJK glyphs exceed Barlow's original cell at smaller sizes.
        cell=max(f['cell'],f['size']+2)
        width=cell*(len(old)+len(more));atlas=Image.new('L',(width,f['h']))
        if old:
            raw=gzip.decompress((src/f['file']).read_bytes());original=Image.frombytes('L',(f['w'],f['h']),raw)
            for i in range(len(old)):atlas.paste(original.crop((i*f['cell'],0,(i+1)*f['cell'],f['h'])),(i*cell,0))
        draw=ImageDraw.Draw(atlas);adv=list(f['adv'])
        for i,ch in enumerate(more,len(old)):
            draw.text((i*cell+1,0),ch,font=font,fill=255,anchor='lt')
            adv.append(min(cell,int(math.ceil(font.getlength(ch)))+1))
        f.update(glyphs=old+more,cell=cell,w=width,adv=adv)
        (out/f['file']).write_bytes(gzip.compress(atlas.tobytes(),compresslevel=9,mtime=0))
        meta[name]=f
    (out/'ui.fonts.json').write_text(json.dumps(meta,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    shutil.copyfile(license_path,out/'OFL-NotoSansSC.txt')
    print('Built',len(meta),'font atlases;',len(meta['f20']['glyphs']),'glyphs each')

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--font',type=pathlib.Path,required=True);p.add_argument('--license',type=pathlib.Path,required=True)
    a=p.parse_args();main(a.font,a.license)
