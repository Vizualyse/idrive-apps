// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Where a game's CPU goes on the play bench, now, over a few seconds
 * (test/run_play.sh cpu [SECONDS]): every thread of the tool's uid (Wine,
 * the game, wl-sink) from /proc, by name, with the frames wl-sink took in
 * that time (the game's own counter in the tool's status), so a thread's
 * share can be read as milliseconds a frame. lavapipe's own threads
 * (llvmpipe-N, the CPU standing in for the GPU) are summed apart.
 *
 *   node play_cpu.js [SECONDS] [TOKEN]
 */
'use strict';

const fs = require('fs');
const http = require('http');

const UID = 12996, HZ = 100;
const SECS = Number(process.argv[2]) || 20;
let token = process.argv[3] || '';
try { if (!token) token = fs.readFileSync('/var/opt/vizualyse-steam/state/token', 'utf8').trim(); } catch (e) { /* none */ }

function threads() {
    const out = {};
    fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).forEach((pid) => {
        let st, tids;
        try { st = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); tids = fs.readdirSync('/proc/' + pid + '/task'); } catch (e) { return; }
        const uid = /^Uid:\s+(\d+)/m.exec(st);
        if (!uid || Number(uid[1]) !== UID) return;
        const proc = (/^Name:\s+(.*)$/m.exec(st) || [])[1] || pid;
        tids.forEach((tid) => {
            let s;
            try { s = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/stat', 'utf8'); } catch (e) { return; }
            const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
            out[tid] = { proc: proc, name: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), ticks: Number(f[11]) + Number(f[12]) };
        });
    });
    return out;
}
function commits() {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: Number(process.env.STEAM_PORT) || 8494, path: '/api/status', headers: { 'X-Steam-Token': token } }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { try { const g = JSON.parse(b).game; resolve(g && g.buffers ? g.buffers.commits : null); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

const t0 = threads(), at0 = Date.now();
commits().then((c0) => setTimeout(() => {
    const t1 = threads(), s = (Date.now() - at0) / 1000;
    commits().then((c1) => {
        const frames = c0 !== null && c1 !== null ? c1 - c0 : null, fps = frames !== null ? frames / s : null;
        const by = {};
        let lvp = 0, lvpN = 0, total = 0;
        Object.keys(t1).forEach((tid) => {
            const pct = 100 * ((t1[tid].ticks - (t0[tid] ? t0[tid].ticks : 0)) / HZ) / s;
            if (/^llvmpipe-\d+$/.test(t1[tid].name)) { lvp += pct; lvpN++; return; }
            total += pct;
            const k = t1[tid].name === t1[tid].proc ? t1[tid].name : t1[tid].proc + '/' + t1[tid].name;
            if (!by[k]) by[k] = { pct: 0, n: 0, top: 0 };
            by[k].pct += pct; by[k].n++; by[k].top = Math.max(by[k].top, pct);
        });
        const ms = (pct) => (fps ? ' = ' + (pct * 10 / fps).toFixed(1) + ' ms a frame' : '');
        console.log('over ' + s.toFixed(1) + ' s: ' + (fps !== null ? fps.toFixed(1) + ' frames a second' : 'no frame count') + '; ' + Object.keys(t1).length + ' threads');
        console.log('the game\'s side (all but lavapipe\'s): ' + total.toFixed(0) + ' % of a core' + ms(total));
        if (lvpN) console.log('lavapipe (' + lvpN + ' llvmpipe threads): ' + lvp.toFixed(0) + ' % of a core');
        Object.keys(by).map((k) => ({ k: k, pct: by[k].pct, n: by[k].n, top: by[k].top })).filter((x) => x.pct >= 0.5).sort((a, b) => b.pct - a.pct).slice(0, 16)
            .forEach((x) => console.log('  ' + x.pct.toFixed(1).padStart(6) + ' %' + ms(x.pct).padEnd(22) + '  ' + x.k + (x.n > 1 ? ' (' + x.n + ' threads, the busiest ' + x.top.toFixed(1) + ' %' + ms(x.top) + ')' : '')));
    });
}, SECS * 1000));
