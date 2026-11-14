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
    [20, 'label', 'LT_Label_1Row', 'clusterStatus', 0, 'Connecting...'],
    [30, 'button', 'LT_Button_1Row', 'clusterPick', 3, 'Choose with previews (touch the screen)'],
    [31, 'button', 'LT_Button_1Row', 'clusterTheme1', 3, 'Theme'],
    [32, 'button', 'LT_Button_1Row', 'clusterTheme2', 3, 'Theme'],
    [33, 'button', 'LT_Button_1Row', 'clusterTheme3', 3, 'Theme'],
    [34, 'button', 'LT_Button_1Row', 'clusterTheme4', 3, 'Theme'],
    [35, 'button', 'LT_Button_1Row', 'clusterTheme5', 3, 'Theme'],
    [36, 'button', 'LT_Button_1Row', 'clusterTheme6', 3, 'Theme'],
    [37, 'button', 'LT_Button_1Row', 'clusterTheme7', 3, 'Theme'],
    [38, 'button', 'LT_Button_1Row', 'clusterTheme8', 3, 'Theme'],
    [39, 'button', 'LT_Button_1Row', 'clusterMode', 3, 'Sport or Comfort: by the drive mode'],
    [40, 'button', 'LT_Button_1Row', 'clusterCover', 3, "The car's strip under the theme: shown"],
    [41, 'button', 'LT_Button_1Row', 'clusterEnable', 3, 'Cluster themes: off'],
];
const dir = path.join(T, 'rhmiData', 'uiDescriptions', 'ID7');
let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- SPDX-License-Identifier: GPL-3.0-or-later -->\n<!-- Copyright (C) 2026 Yousaf Khan -->\n<application>\n' +
    '    <container id="1" type="state" widget="LT_State_Wide">\n        <layoutGroup id="100" name="Titlebar">\n' +
    '            <component id="10" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="200" name="List">\n            <property id="3" value="1"/>\n';
C.forEach(([id, type, widget, , focus]) => {
    xml += `            <component id="${id}" type="${type}" widget="${widget}">\n                <property id="2" value="1"/>\n                <property id="3" value="${focus}"/>\n            </component>\n`;
});
/* The screen state (2, ParentState 1): opened while the picker covers the
 * app area. Nothing focusable or touchable on it, because the HMI still
 * gets every touch on the picker and would press whatever lies under it.
 * BACK (the arrow outside the picker) returns to the main page. */
xml += '        </layoutGroup>\n    </container>\n' +
    '    <container id="2" type="state" widget="LT_State_Wide">\n        <property id="9" value="1"/>\n' +
    '        <layoutGroup id="101" name="Titlebar">\n' +
    '            <component id="50" type="title">\n                <property id="2" value="1"/>\n            </component>\n        </layoutGroup>\n' +
    '        <layoutGroup id="201" name="List">\n            <property id="3" value="1"/>\n' +
    '            <component id="51" type="label" widget="LT_Label_1Row">\n                <property id="2" value="1"/>\n                <property id="3" value="0"/>\n            </component>\n' +
    '        </layoutGroup>\n    </container>\n</application>\n';
fs.writeFileSync(path.join(dir, 'application.xml'), xml);
const vis = { Visible: { value: 1, type: 'UInt' } };
const comps = { 10: { type: 'title', name: 'clusterTitle', properties: vis, rows: [{ Text: { value: 'SID_CLUSTER_TITLE', type: 'StringId' } }] } };
C.forEach(([id, type, , name, focus, text]) => {
    const properties = Object.assign({}, vis, { Focusable: { value: focus, type: 'UInt' } });
    comps[id] = { type: type, name: name, properties: properties, rows: [text === null ? {} : { Text: { value: text, type: 'Text' } }] };
});
fs.writeFileSync(path.join(dir, 'uiDescription.json'),
    JSON.stringify({ schemaVersion: '1.3.0', containers: {
        1: { type: 'state', name: 'ST_OnlineApps_VizualyseCluster', components: comps },
        2: { type: 'state', name: 'ST_OnlineApps_VizualyseClusterScreen', components: {
            50: { type: 'title', name: 'clusterScreenTitle', properties: vis, rows: [{ Text: { value: 'SID_CLUSTER_TITLE', type: 'StringId' } }] },
            51: { type: 'label', name: 'clusterScreenNote', properties: Object.assign({}, vis, { Focusable: { value: 0, type: 'UInt' } }),
                rows: [{ Text: { value: 'The theme picker is on the screen. Back returns here.', type: 'Text' } }] },
        } },
    } }, null, 2) + '\n');
console.log('page: ' + C.length + ' rows');
