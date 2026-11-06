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
    [20, 'label', 'LT_Label_1Row', 'steamStatus', 0, 'Connecting...'],
    [40, 'label', 'LT_Label_1Row', 'steamGame', 0, ''],
    [30, 'button', 'LT_Button_1Row', 'steamShow', 3, 'Show on the screen'],
    [31, 'button', 'LT_Button_1Row', 'steamStop', 3, 'Stop the game'],
    [32, 'button', 'LT_Button_1Row', 'steamPlay1', 3, 'Play'],
    [33, 'button', 'LT_Button_1Row', 'steamPlay2', 3, 'Play'],
    [34, 'button', 'LT_Button_1Row', 'steamPlay3', 3, 'Play'],
    [35, 'button', 'LT_Button_1Row', 'steamPlay4', 3, 'Play'],
    [41, 'label', 'LT_Label_1Row', 'steamDownload', 0, ''],
    [21, 'label', 'LT_Label_1Graphic_Scalable', 'steamQr', 0, null],
    [22, 'label', 'LT_Label_1Row', 'steamLink', 0, ''],
    [23, 'label', 'LT_Label_1Row', 'steamHint', 0, ''],
    [36, 'button', 'LT_Button_1Row', 'steamResolution', 3, 'Picture: 1280x720'],
    [37, 'button', 'LT_Button_1Row', 'steamEnable', 3, 'Steam: on'],
];
const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright (C) 2026 Yousaf Khan -->\n<application>\n' +
    '    <container id="1" type="state" widget="LT_State_Wide">\n        <layoutGroup id="100" name="Titlebar">\n' +
    '            <component id="10" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="200" name="List">\n            <property id="3" value="1"/>\n';
C.forEach(([id, type, widget, , focus]) => {
    xml += `            <component id="${id}" type="${type}" widget="${widget}">\n                <property id="2" value="1"/>\n                <property id="3" value="${focus}"/>\n            </component>\n`;
});
/* The screen state (2, ParentState 1): opened while the game covers the app
 * area. Nothing focusable or touchable on it, because the HMI still gets
 * every touch on the game and would press whatever lies under it. BACK (the
 * arrow outside the game) returns to the main page. */
xml += '        </layoutGroup>\n    </container>\n' +
    '    <container id="2" type="state" widget="LT_State_Wide">\n        <property id="9" value="1"/>\n' +
    '        <layoutGroup id="101" name="Titlebar">\n' +
    '            <component id="50" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="201" name="List">\n            <property id="3" value="1"/>\n' +
    '            <component id="51" type="label" widget="LT_Label_1Row">\n                <property id="2" value="1"/>\n                <property id="3" value="0"/>\n            </component>\n' +
    '        </layoutGroup>\n    </container>\n</application>\n';
fs.writeFileSync(path.join(dir, 'application.xml'), xml);
const vis = { Visible: { value: 1, type: 'UInt' } };
const comps = { 10: { type: 'title', name: 'steamTitle', properties: vis, rows: [{ Text: { value: 'SID_STEAM_TITLE', type: 'StringId' } }] } };
C.forEach(([id, type, , name, focus, text]) => {
    const properties = Object.assign({}, vis, { Focusable: { value: focus, type: 'UInt' } });
    comps[id] = { type: type, name: name, properties: properties, rows: [text === null ? {} : { Text: { value: text, type: 'Text' } }] };
});
fs.writeFileSync(path.join(dir, 'uiDescription.json'),
    JSON.stringify({ schemaVersion: '1.3.0', containers: {
        1: { type: 'state', name: 'ST_OnlineApps_VizualyseSteam', components: comps },
        2: { type: 'state', name: 'ST_OnlineApps_VizualyseSteamScreen', components: {
            50: { type: 'title', name: 'steamScreenTitle', properties: vis, rows: [{ Text: { value: 'SID_STEAM_TITLE', type: 'StringId' } }] },
            51: { type: 'label', name: 'steamScreenNote', properties: Object.assign({}, vis, { Focusable: { value: 0, type: 'UInt' } }),
                rows: [{ Text: { value: 'The game is on the screen. Back returns here.', type: 'Text' } }] },
        } },
    } }, null, 2) + '\n');
console.log('page: ' + C.length + ' rows');
