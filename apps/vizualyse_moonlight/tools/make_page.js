// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* Writes the page (application.xml and uiDescription.json) from one list,
 * so the two always agree.  node tools/make_page.js <staged tree> */
'use strict';
const fs = require('fs');
const path = require('path');
const T = process.argv[2];
/* [id, type, widget, name, focusable, first text] */
const C = [
    [20, 'label', 'LT_Label_1Row', 'moonlightStatus', 0, 'Connecting…'],
    [21, 'label', 'LT_Label_1Graphic_Scalable', 'moonlightQr', 0, null],
    [22, 'label', 'LT_Label_1Row', 'moonlightLink', 0, ''],
    [23, 'label', 'LT_Label_1Row', 'moonlightHint', 0, ''],
    [30, 'button', 'LT_Button_1Row', 'moonlightEnable', 3, 'Moonlight: on'],
    [31, 'button', 'LT_Button_1Row', 'moonlightStop', 3, 'Stop'],
    [32, 'button', 'LT_Button_1Row', 'moonlightQuit', 3, 'Quit game'],
    [33, 'button', 'LT_Button_1Row', 'moonlightResume', 3, 'Resume last'],
    [40, 'label', 'LT_Label_1Row', 'moonlightInfo', 0, ''],
];
const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright (C) 2026 Yousaf Khan -->\n<application>\n' +
    '    <container id="1" type="state" widget="LT_State_Wide">\n        <layoutGroup id="100" name="Titlebar">\n' +
    '            <component id="10" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="200" name="List">\n            <property id="3" value="1"/>\n';
C.forEach(([id, type, widget, , focus]) => {
    xml += `            <component id="${id}" type="${type}" widget="${widget}">\n                <property id="2" value="1"/>\n                <property id="3" value="${focus}"/>\n            </component>\n`;
});
xml += '        </layoutGroup>\n    </container>\n</application>\n';
fs.writeFileSync(path.join(dir, 'application.xml'), xml);
const vis = { Visible: { value: 1, type: 'UInt' } };
const comps = { 10: { type: 'title', name: 'moonlightTitle', properties: vis, rows: [{ Text: { value: 'SID_MOONLIGHT_TITLE', type: 'StringId' } }] } };
C.forEach(([id, type, , name, focus, text]) => {
    comps[id] = { type: type, name: name, properties: Object.assign({}, vis, { Focusable: { value: focus, type: 'UInt' } }),
        rows: [text === null ? {} : { Text: { value: text, type: 'Text' } }] };
});
fs.writeFileSync(path.join(dir, 'uiDescription.json'),
    JSON.stringify({ schemaVersion: '1.3.0', containers: { 1: { type: 'state', name: 'ST_OnlineApps_VizualyseMoonlight', components: comps } } }, null, 2) + '\n');
console.log('page: ' + C.length + ' rows');
