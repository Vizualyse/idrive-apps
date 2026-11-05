// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The person at the PC, for the off-car tests: Sunshine's web API (login
 * admin / admin, set by test/sunshine/run.sh). */
'use strict';
const https = require('https');

/* Sunshine's web API with the web login. */
function web(host, method, p, obj) {
    const body = obj ? JSON.stringify(obj) : '';
    return new Promise((resolve, reject) => {
        const req = https.request({ host: host, port: 47990, path: p, method: method, rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                Authorization: 'Basic ' + Buffer.from('admin:admin').toString('base64') } }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ status: false, error: res.statusCode + ' ' + b.trim() }); } });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/* What a person does on Sunshine's PIN page: picks the pending request
 * (Sunshine 2026 lists them: GET /api/pin) and types the PIN for it. */
async function typePin(host, pin) {
    for (let i = 0; i < 20; i++) {
        const list = await web(host, 'GET', '/api/pin');
        const p = (list.pairings || [])[0];
        if (p) {
            const r = await web(host, 'POST', '/api/pin', { pairing_id: p.id, pin: pin, name: 'iDrive test' });
            return JSON.stringify(p) + ' -> ' + JSON.stringify(r);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return 'no pending pairing request';
}


module.exports = { web, typePin };
