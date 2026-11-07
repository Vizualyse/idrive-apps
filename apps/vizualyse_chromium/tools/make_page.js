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
    [20, 'label', 'LT_Label_1Row', 'browserStatus', 0, 'Connecting...'],
    [21, 'label', 'LT_Label_1Graphic_Scalable', 'browserQr', 0, null],
    [22, 'label', 'LT_Label_1Row', 'browserLink', 0, ''],
    [23, 'label', 'LT_Label_1Row', 'browserHint', 0, ''],
    [30, 'button', 'LT_Button_1Row', 'browserShow', 3, 'Show on the screen'],
    [31, 'button', 'LT_Button_1Row', 'browserEnable', 3, 'Browser: on'],
    [35, 'button', 'LT_Button_1Row', 'browserGpuMode', 3, 'GPU mode: off (WebGL on the CPU)'],
    [36, 'button', 'LT_Button_1Row', 'browserResolution', 3, 'Resolution: full'],
    [37, 'button', 'LT_Button_1Row', 'browserRoom', 3, 'Make room: off'],
    [38, 'button', 'LT_Button_1Row', 'browserGame', 3, 'Game mode: off'],
    [32, 'button', 'LT_Button_1Row', 'browserHome', 3, 'Home page'],
    [33, 'button', 'LT_Button_1Row', 'browserReload', 3, 'Reload'],
    [34, 'button', 'LT_Button_1Row', 'browserBack', 3, 'Back'],
    [40, 'label', 'LT_Label_1Row', 'browserPage', 0, ''],
    [41, 'label', 'LT_Label_1Row', 'browserGpu', 0, ''],
];
const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright (C) 2026 Yousaf Khan -->\n<application>\n' +
    '    <container id="1" type="state" widget="LT_State_Wide">\n        <layoutGroup id="100" name="Titlebar">\n' +
    '            <component id="10" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="200" name="List">\n            <property id="3" value="1"/>\n';
C.forEach(([id, type, widget, , focus]) => {
    xml += `            <component id="${id}" type="${type}" widget="${widget}">\n                <property id="2" value="1"/>\n                <property id="3" value="${focus}"/>\n            </component>\n`;
});
/* The screen state (2, ParentState 1): opened while the browser covers the
 * app area. Nothing focusable or touchable on it, because the HMI still gets
 * every touch on the browser (read passively) and would press whatever lies
 * under it. BACK (the arrow outside the browser) returns to the main page. */
xml += '        </layoutGroup>\n    </container>\n' +
    '    <container id="2" type="state" widget="LT_State_Wide">\n        <property id="9" value="1"/>\n' +
    '        <layoutGroup id="101" name="Titlebar">\n' +
    '            <component id="50" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="201" name="List">\n            <property id="3" value="1"/>\n' +
    '            <component id="51" type="label" widget="LT_Label_1Row">\n                <property id="2" value="1"/>\n                <property id="3" value="0"/>\n            </component>\n' +
    '        </layoutGroup>\n    </container>\n</application>\n';
fs.writeFileSync(path.join(dir, 'application.xml'), xml);
const vis = { Visible: { value: 1, type: 'UInt' } };
const comps = { 10: { type: 'title', name: 'browserTitle', properties: vis, rows: [{ Text: { value: 'SID_CHROMIUM_TITLE', type: 'StringId' } }] } };
C.forEach(([id, type, , name, focus, text, items]) => {
    const properties = Object.assign({}, vis, { Focusable: { value: focus, type: 'UInt' } });
    /* a drop-down: its header and choice in cells, one row per item (as upstream's Waze "Show on") */
    comps[id] = items ? { type: type, name: name, properties: properties,
        cells: { HeaderText: { value: text, type: 'Text' }, SelectedItem: { value: 0, type: 'UInt' } },
        rows: items.map((t) => ({ ItemText: { value: t, type: 'Text' } })) }
        : { type: type, name: name, properties: properties, rows: [text === null ? {} : { Text: { value: text, type: 'Text' } }] };
});
fs.writeFileSync(path.join(dir, 'uiDescription.json'),
    JSON.stringify({ schemaVersion: '1.3.0', containers: {
        1: { type: 'state', name: 'ST_OnlineApps_VizualyseChromium', components: comps },
        2: { type: 'state', name: 'ST_OnlineApps_VizualyseChromiumScreen', components: {
            50: { type: 'title', name: 'browserScreenTitle', properties: vis, rows: [{ Text: { value: 'SID_CHROMIUM_TITLE', type: 'StringId' } }] },
            51: { type: 'label', name: 'browserScreenNote', properties: Object.assign({}, vis, { Focusable: { value: 0, type: 'UInt' } }),
                rows: [{ Text: { value: 'The browser is on the screen. Back returns here.', type: 'Text' } }] },
        } },
    } }, null, 2) + '\n');
console.log('page: ' + C.length + ' rows');
