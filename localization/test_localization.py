#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build all five localized source packages and exercise their shared touch renderer."""
import json
import pathlib
import re
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET

from prepare import APPS, CREDIT, prepare

RENDER_CHECK = """
const assert = require('assert');
const path = require('path');
const dir = path.resolve(process.argv[1]);
const {Canvas, measure} = require(path.join(dir, 'ui_canvas.js'));
const {loadFonts, frame} = require(path.join(dir, 'ui_kit.js'));
const {translate, CREDIT} = require(path.join(dir, 'i18n.js'));
const fonts = loadFonts(dir);
assert.equal(translate('Settings'), '设置');
assert.equal(translate('https://example.com/Settings'), 'https://example.com/Settings');
assert.equal(measure(fonts.f20, 'Settings'), measure(fonts.f20, '设置'));
const glyph = new Canvas(120, 24, 0);
glyph.text(fonts.f20, '设置', 0, 0, 0xffffff);
assert(glyph.px.some((pixel, index) => index % 4 !== 3 && pixel !== 0), 'Chinese glyphs are visible');
for (const char of CREDIT) assert(char in fonts.f14.index);
assert(frame(fonts, {body: []}, {}).some((row) => row.text === CREDIT));
"""


def check(out):
    for name, title in APPS.items():
        app = out / 'apps' / f'vizualyse_{name}'
        subprocess.run(['node', str(app / 'tools/build.js')], check=True)
        package, = app.glob('*.src.tgz')
        with tarfile.open(package) as archive:
            manifest = json.load(archive.extractfile('mgu-app.json'))
            assert 'src/i18n.js' in archive.getnames()
            rhmi = f"{manifest['tree']}/rhmiData"
            ui_dir = f'{rhmi}/uiDescriptions/ID7'
            page = archive.extractfile(f'{ui_dir}/uiDescription.json').read().decode('utf-8')
            assert CREDIT in page
            xml = ET.parse(archive.extractfile(f'{ui_dir}/application.xml'))
            assert xml.find(".//component[@id='900']") is not None
            strings = json.load(archive.extractfile(f'{rhmi}/variantGroups/Common/texts/en_GB.json'))
            assert title in strings.values()
        tool = out / 'native' / f'vizualyse-{name}'
        component = json.loads((tool / 'component.json').read_text(encoding='utf-8'))
        assert all((tool / entry['from']).exists() for entry in component['files']
                   if entry['path'].startswith('ui.') or entry['path'] == 'i18n.js')
        subprocess.run(['node', '-e', RENDER_CHECK, str(tool / 'src')], check=True)
        phone = tool / 'src/page.html'
        if phone.exists():
            html = phone.read_text(encoding='utf-8')
            assert CREDIT in html
            _, translator = re.findall(r'<script>(.*?)</script>', html, re.S)[-2:]
            subprocess.run(['node', '--check', '-'], input=translator.encode(), check=True)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as directory:
        out = pathlib.Path(directory) / 'zh-CN'
        prepare(out)
        check(out)
