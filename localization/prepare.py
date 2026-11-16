#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 小白151 (JackieZ123430)
"""Create a separate Chinese source tree; never modify the input checkout.

python localization/prepare.py --out ../idrive-apps-zh-CN
The output keeps app IDs and protocol values. Build its apps normally.
"""
import argparse, json, pathlib, re, shutil, subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
CREDIT = 'Translation by: 抖音 小白科技杂物社 · BiliBili 小白151 · GitHub JackieZ123430'
APPS = {'cast': '仪表投射', 'chromium': '浏览器', 'cluster': '仪表主题',
        'moonlight': 'Moonlight 串流', 'steam': '车载 Steam'}

def dictionary():
    result = {}
    for number, line in enumerate((HERE/'zh-CN.tsv').read_text(encoding='utf-8').splitlines(), 1):
        if not line or line.startswith('#'): continue
        key, value = line.split('\t')
        if key in result: raise ValueError(f'Duplicate translation on line {number}: {key}')
        if not value: raise ValueError(f'Empty translation on line {number}')
        result[key] = value
    return result

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')

def replace(path, old, new, count=1):
    s=path.read_text(encoding='utf-8')
    if s.count(old) != count: raise ValueError(f'Expected {count} display hook(s) in {path}: {old}')
    path.write_text(s.replace(old,new),encoding='utf-8')

def prepare(out):
    out=out.resolve()
    if out.exists(): raise ValueError('Output directory already exists; choose a new directory')
    if out.is_relative_to(ROOT): raise ValueError('Output must be outside the input checkout')
    d=dictionary()
    # Platform copies are regenerated, never patched after a sync.
    shutil.copytree(ROOT,out,ignore=shutil.ignore_patterns('.git','__pycache__','*.tgz','build','out'))
    translator=(HERE/'translator.js').read_text(encoding='utf-8')
    runtime=translator+'\nconst translate = createTranslator('+json.dumps(d,ensure_ascii=False)+');\n'+\
        'module.exports = { translate, CREDIT: '+json.dumps(CREDIT,ensure_ascii=False)+' };\n'
    for app, title in APPS.items():
        folder=out/'apps'/('vizualyse_'+app)
        m=json.loads((folder/'mgu-app.json').read_text(encoding='utf-8'))
        m['modules'].append('src/i18n.js'); write_json(folder/'mgu-app.json',m)
        (folder/'src/i18n.js').write_text(runtime,encoding='utf-8')
        entry=folder/'src'/('vizualyse_'+app+'.js')
        replace(entry,"'use strict';","'use strict';\nconst { translate } = require('./i18n.js');")
        replace(entry,'const t = oneRow(text);','const t = oneRow(translate(text));')
        # Non-focusable credit in the iDrive list. Generate both RHMI files
        # from the same row, rather than inserting an unmatched component.
        page=folder/'tools/make_page.js'
        replace(page,"const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');",
            'C.push([900, \'label\', \'LT_Label_1Row\', \'translationCredit\', 0, '+json.dumps(CREDIT,ensure_ascii=False)+']);\n'+
            "const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');")
        subprocess.run(['node',str(page),str(folder/m['tree'])],check=True,stdout=subprocess.DEVNULL)
        # Translate only RHMI Text values, not identifiers or properties.
        def texts(obj):
            if isinstance(obj,dict):
                if obj.get('type')=='Text' and isinstance(obj.get('value'),str):
                    obj['value']=d.get(obj['value'],obj['value'])
                for value in obj.values(): texts(value)
            elif isinstance(obj,list):
                for value in obj:texts(value)
        rhmi=folder/m['tree']/'rhmiData'
        ui=rhmi/'uiDescriptions/ID7/uiDescription.json'
        data=json.loads(ui.read_text(encoding='utf-8'));texts(data);write_json(ui,data)
        tf=rhmi/'variantGroups/Common/texts/en_GB.json'
        ts={key:title for key in json.loads(tf.read_text(encoding='utf-8'))}
        for name in ['en_GB','zh_CN','zh_yue_Hans_CN']:write_json(tf.with_name(name+'.json'),ts)
        r=json.loads((folder/'release.json').read_text(encoding='utf-8'));r['title']=title
        r['description']='简体中文：'+title+'。汉化：小白151 / JackieZ123430。'+r.get('description','')
        write_json(folder/'release.json',r)
        tool=out/'native'/('vizualyse-'+app)
        (tool/'src/i18n.js').write_text(runtime,encoding='utf-8')
        c=json.loads((tool/'component.json').read_text(encoding='utf-8'));c['title']=title+'（后台组件）'
        c['files'].append({'path':'i18n.js','from':'src/i18n.js','mode':'0644'})
        c['files'].append({'path':'NOTICE.zh-CN.md','from':'NOTICE.zh-CN.md','mode':'0644'})
        shutil.copyfile(ROOT/'NOTICE.zh-CN.md',tool/'NOTICE.zh-CN.md')
        c['files'].append({'path':'OFL-NotoSansSC.txt','from':'OFL-NotoSansSC.txt','mode':'0644'})
        shutil.copyfile(HERE/'fonts/OFL-NotoSansSC.txt',tool/'OFL-NotoSansSC.txt')
        # Extra, small font only for the watermark in the gap above status.
        c['platform']['tool/touch_ui']['files']['src/ui.f14.font.gz']='ui.f14.font.gz'
        c['files'].append({'path':'ui.f14.font.gz','from':'src/ui.f14.font.gz','mode':'0644'})
        write_json(tool/'component.json',c)
        phone=tool/'src/page.html'
        if phone.exists():
            source=phone.read_text(encoding='utf-8')
            extra='\n<footer style="opacity:.6;font-size:12px;margin:20px 0">'+CREDIT+'</footer>\n<script>\n'+translator+\
                '\nconst VIZUALYSE_ZH_CN = '+json.dumps(d,ensure_ascii=False).replace('</','<\\/')+';\n'+(HERE/'phone.js').read_text(encoding='utf-8')+'\n</script>\n'
            if '</body>' in source:source=source.replace('</body>',extra+'</body>')
            else:source+=extra
            phone.write_text(source,encoding='utf-8')
    # These are the shared platform originals in the *generated* tree only.
    kit=out/'platform/tool/touch_ui/1.0.0'
    canvas=kit/'ui_canvas.js'
    replace(canvas,"'use strict';","'use strict';\nconst { translate } = require('./i18n.js');")
    replace(canvas,'text(font, str, x, y, colour, align, maxW) {',
        'text(font, str, x, y, colour, align, maxW) {\n        str = translate(String(str));')
    replace(canvas,'function measure(font, str) {','function measure(font, str) {\n    str = translate(String(str));')
    replace(canvas,'str = String(str);','str = translate(String(str));')
    replace(kit/'ui_kit.js','    return out;\n}\n\n/* problems with',
        '    out.push({ id: \'_translationCredit\', kind: \'text\', x: 24, y: 566, w: 1742, h: 16, font: \'f14\', align: \'right\', colour: \'mute\', text: require(\'./i18n.js\').CREDIT });\n    return out;\n}\n\n/* problems with')
    for f in (HERE/'fonts').glob('ui.*'):shutil.copyfile(f,kit/f.name)
    subprocess.run(['node',str(out/'platform/platform.js'),'sync'],check=True,stdout=subprocess.DEVNULL)
    write_json(out/'localization-build.json',{'language':'zh-CN','credit':CREDIT,'entries':len(d),'applications':list(APPS)})
    print(json.dumps({'output':str(out),'translations':len(d),'applications':len(APPS)}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=pathlib.Path,required=True)
    args=parser.parse_args();prepare(args.out)
