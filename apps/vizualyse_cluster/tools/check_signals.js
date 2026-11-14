// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Checks the app's manifest against a unit's SOME/IP catalog before it goes
 * to the car: BMW's installer refuses the whole app for one field, access or
 * instance its catalog lacks (knowledge/vehicle-signals.md). For every
 * proxy with attributes: the interface is in the catalog, each field is,
 * "r" only where the field has a getter, "s" only where it has a notifier;
 * and every reading in src/vehicle_signals.js is in the manifest with its
 * access (or its interface is "*").
 *
 *   node tools/check_signals.js <someip-interfaces.json>
 *
 * The catalog: /etc/oap/someip/someip-interfaces.json on the unit (or from
 * a rootfs copy: idrive-rootfs/<version>/rootfs.tar). Not in the repo.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/check_signals.js <someip-interfaces.json>'); process.exit(2); }
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const ROOT = path.join(__dirname, '..');
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, app.tree, 'manifest.json'), 'utf8'));
const { READINGS } = require(path.join(ROOT, 'src', 'vehicle_signals.js'));

const bad = [];
let fields = 0;
Object.keys(manifest.proxies).forEach((iface) => {
    const p = manifest.proxies[iface];
    if (!p || typeof p !== 'object' || !p.attributes) return;
    const I = catalog.interfaces[iface];
    if (!I) { bad.push(iface + ': not in the catalog'); return; }
    const ids = catalog.instanceIDs && catalog.instanceIDs[iface];
    (Array.isArray(p.instances) ? p.instances : [p.instances]).forEach((n) => {
        if (ids && !Object.prototype.hasOwnProperty.call(ids, n)) bad.push(iface + ': instance "' + n + '" not in the catalog (' + Object.keys(ids).join(', ') + ')');
    });
    Object.keys(p.attributes).forEach((f) => {
        fields++;
        const F = I.fields && I.fields[f], a = p.attributes[f];
        if (!F) { bad.push(iface + '.' + f + ': no such field'); return; }
        if (/[^rsw]/.test(a)) bad.push(iface + '.' + f + ': access "' + a + '" (r, s, w only)');
        if (a.indexOf('r') >= 0 && !F.getter) bad.push(iface + '.' + f + ': "r" but the field has no getter');
        if (a.indexOf('s') >= 0 && !F.notifier) bad.push(iface + '.' + f + ': "s" but the field has no notifier');
        if (a.indexOf('w') >= 0 && !F.setter) bad.push(iface + '.' + f + ': "w" but the field has no setter');
    });
});
READINGS.forEach((r) => {
    const p = manifest.proxies[r.iface];
    if (p === '*') return;
    if (!p || !p.attributes || p.attributes[r.field] !== r.access) bad.push('vehicle_signals.js reads ' + r.iface + '.' + r.field + ' ("' + r.access + '"), the manifest asks ' + JSON.stringify(p && p.attributes && p.attributes[r.field]));
    if (p && Array.isArray(p.instances) && p.instances.indexOf('1') < 0) bad.push(r.iface + ': instance 1 not asked for');
});
if (bad.length) { bad.forEach((b) => console.log('FAIL ' + b)); process.exit(1); }
console.log('ok   ' + fields + ' fields on ' + Object.keys(manifest.proxies).filter((k) => manifest.proxies[k].attributes).length +
    ' interfaces match the catalog (' + (catalog.version || '?') + '); every reading is in the manifest');
