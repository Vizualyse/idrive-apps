// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * server.js as the unit runs it, on the unit's own root filesystem
 * (run_unit_test.sh server), with a stand-in mgu-render client
 * (test/fake/render_client.js), SwiftShader for Vulkan, no network, touches
 * replayed from a file:
 *
 * - it unpacks the bundle, starts Chromium and probes it: gpu.json says JSPI
 *   ok, WebGPU compute ok;
 * - the phone page needs the token; /api/go opens a page;
 * - the iDrive app's socket: "show" puts the page in the app area
 *   (1790x638+108+82) and pictures reach the frame file; a touch in the
 *   area presses the page's button, one outside (the HMI's strip) doesn't;
 * - the speed: 20 km/h hides it and "show" is refused, 0 km/h allows it;
 * - the GPU mode: off at start (a leftover gpu-trial is reported), "gpu" on
 *   restarts Chromium through the EGL shim, and with no GPU here it goes
 *   back to the CPU by itself;
 * - "disable" stops Chromium.
 *
 *   node server_test.js <tool folder>
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const T = process.argv[2] || '/t';
const STATE = '/var/opt/vizualyse-chromium/state';
const FRAME = '/dev/shm/mgu-video-vizualyse_chromium';
const RLOG = '/dev/shm/render.log';
const TOUCH = '/dev/shm/touch.txt';
const CTL = '/dev/shm/vizualyse-chromium/ctl.sock';
const SYSTEMCTL = '/var/opt/fake-systemctl';   /* /dev/shm is noexec in the container */
let fails = 0;
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, p, body, tok) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const r = http.request({ host: '127.0.0.1', port: 8491, method: method, path: p, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { 'X-Chromium-Token': tok } : {}) }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ code: res.statusCode, body: j }); });
        });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

async function until(what, fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
        let v = null;
        try { v = await fn(); } catch (e) { v = null; }
        if (v) return v;
        if (Date.now() > end) { check(false, what + ' (timed out)'); return null; }
        await wait(250);
    }
}

function touchFile(sx, sy) {
    const pdu = (ev) => {
        const b = Buffer.alloc(112);
        b.writeUInt32BE(0xB0048002, 0); b.writeUInt32BE(96, 4);
        b[28] = 0x80; b[53] = 1; b.writeUInt16BE(sx, 54); b.writeUInt16BE(sy, 60); b[62] = 50; b[63] = ev << 4;
        return b.toString('hex');
    };
    fs.writeFileSync(TOUCH + '.tmp', ['0 160.48.199.115 112 ' + pdu(1), '40 160.48.199.115 112 ' + pdu(3)].join('\n') + '\n');
    fs.chownSync(TOUCH + '.tmp', 65534, 65534);
    fs.renameSync(TOUCH + '.tmp', TOUCH);
}

/* the page: red / blue halves, a button at 270,90 100x60 that sets the title */
const PAGE = '<!doctype html><title>start</title><style>body{margin:0}#l,#r{position:fixed;top:0;bottom:0;width:50%}#l{left:0;background:#f00}#r{right:0;background:#00f}' +
    'button{position:fixed;left:270px;top:90px;width:100px;height:60px}</style><div id=l></div><div id=r></div>' +
    '<button onclick="document.title=\'tapped \'+(++window.n||(window.n=1))">tap</button>';

function ctl() {
    return new Promise((resolve, reject) => {
        const s = net.connect(CTL, () => resolve({
            send: (o) => s.write(JSON.stringify(o) + '\n'),
            close: () => s.destroy(),
            last: () => s.lastStatus,
            errors: s.errors,
        }));
        s.errors = [];
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev === 'status') s.lastStatus = m;
                if (m.ev === 'error') s.errors.push(m.error);
            }
        });
        s.on('error', reject);
    });
}

async function main() {
    const site = http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(PAGE); }).listen(8999, '127.0.0.1');
    const srvEnv = Object.assign({}, process.env, {
        CHROMIUM_ARCHIVE: path.join(T, 'build/chromium.tgz'),
        CHROMIUM_RENDER_CLIENT: path.join(T, 'test/fake/render_client.js'),
        CHROMIUM_TEST_RENDER_LOG: RLOG,
        CHROMIUM_NO_FIREWALL: '1', CHROMIUM_NO_PROXY: '1', CHROMIUM_CGROUP_ROOT: '/dev/shm/cg',
        CHROMIUM_TOUCH_IFACE: '', CHROMIUM_TOUCH_FILE: TOUCH, CHROMIUM_LINK_IP: '127.0.0.1',
        CHROMIUM_SYSTEMCTL: SYSTEMCTL, CHROMIUM_RECMGR_INI: '/dev/shm/recmgr.ini', CHROMIUM_RECMGR_AT_BOOT: '/dev/shm/recmgr-at-boot.json',
    });
    /* a stand-in systemctl (Moonlight and Cast running) and recmgr list:
     * Moonlight in both sections, Cast in [Whitelist] only, so stopping
     * Cast would restart the head unit and must not happen */
    fs.writeFileSync(SYSTEMCTL, ['#!/bin/sh', 'echo "$*" >> /dev/shm/systemctl.log', 'f=/dev/shm/units/$2',
        'case "$1" in', 'is-active) if [ -f "$f" ]; then echo active; exit 0; fi; echo inactive; exit 3;;',
        'stop) rm -f "$f";;', 'start) : > "$f";;', 'esac', ''].join('\n'), { mode: 0o755 });
    try { fs.mkdirSync('/dev/shm/units', 0o755); } catch (e) { /* there */ }
    ['vizualyse-moonlight.service', 'vizualyse-cast.service'].forEach((u) => fs.writeFileSync('/dev/shm/units/' + u, ''));
    fs.writeFileSync('/dev/shm/systemctl.log', '');
    const ini = ['[Whitelist]', 'vizualyse-moonlight', 'vizualyse-cast', '[WhitelistExitSuccess]', 'vizualyse-moonlight', ''].join('\n');
    fs.writeFileSync('/dev/shm/recmgr.ini', ini);
    fs.writeFileSync('/dev/shm/recmgr-at-boot.json', JSON.stringify({ boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), text: ini }));
    /* a stand-in memory cgroup (v1 files) */
    const CG = '/dev/shm/cg/vizualyse-chromium';
    ['/dev/shm/cg', CG].forEach((d) => { try { fs.mkdirSync(d, 0o755); } catch (e) { /* there */ } });
    const oom = (n) => fs.writeFileSync(path.join(CG, 'memory.oom_control'), ['oom_kill_disable 0', 'under_oom 0', 'oom_kill ' + n, ''].join('\n'));
    fs.writeFileSync(path.join(CG, 'cgroup.procs'), '');
    fs.writeFileSync(path.join(CG, 'memory.usage_in_bytes'), String(700 * 1048576));
    fs.writeFileSync(path.join(CG, 'memory.max_usage_in_bytes'), String(900 * 1048576));
    oom(0);
    /* a GPU try that never ended: as after a restart of the unit */
    ['/var/opt', '/var/opt/vizualyse-chromium', STATE].forEach((d) => { try { fs.mkdirSync(d, 0o755); } catch (e) { /* there */ } });
    fs.writeFileSync(path.join(STATE, 'gpu-trial'), '{"at":"2026-11-06T11:00:00Z"}\n');
    const lines = [];
    const srv = spawn('/usr/bin/node', [path.join(T, 'src/server.js')], { env: srvEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (d) => String(d).split('\n').filter(Boolean).forEach((l) => { lines.push(l); if (process.env.VERBOSE) console.log('  | ' + l); });
    srv.stdout.on('data', keep);
    srv.stderr.on('data', keep);

    const tok = await until('the token is written', () => fs.readFileSync(path.join(STATE, 'token'), 'utf8').trim(), 10000);
    const denied = await until('the phone page answers', () => req('GET', '/api/status'), 10000);
    check(denied.code === 403, 'the phone page wants the token (' + denied.code + ')');
    const st = await until('Chromium runs and is probed', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.browser === 'running' && r.body.gpu && r.body.gpu.at && fs.existsSync(path.join(STATE, 'gpu.txt')) ? r.body : null)), 120000);
    if (!st) { console.log(lines.slice(-40).join('\n')); process.exit(1); }
    check(st.gpu.jspi === 'ok', 'JSPI ok (' + st.gpu.jspi + ')');
    check(st.gpu.webgpuCompute === 'ok', 'WebGPU compute ok (' + st.gpu.webgpu + ')');
    check(lines.some((l) => /^@gpu \{/.test(l)), 'the journal gets an @gpu line');
    check(st.link === 'http://127.0.0.1:8491/?t=' + tok, 'the link carries the token');
    check(st.gpuMode === false && st.gpu.mode === 'cpu', 'it starts on the CPU');
    check(/never ended/.test(st.gpuNote || '') && !fs.existsSync(path.join(STATE, 'gpu-trial')), 'a GPU try that never ended is reported once (' + st.gpuNote + ')');

    /* the memory cap: 1536 MB, set on the cgroup; a setting; a kill at the cap is reported */
    check(fs.readFileSync(path.join(CG, 'memory.limit_in_bytes'), 'utf8') === String(1536 * 1048576), 'the cgroup is capped at 1536 MB');
    const m0 = await until('memory read', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.memory && r.body.memory.usedMb === 700 ? r.body.memory : null)), 5000);
    check(!!m0 && m0.capMb === 1536 && m0.peakMb === 900 && !m0.note, 'status: 700 MB used, 900 at most, 1536 cap');
    const bad = await req('POST', '/api/memory', { mb: 4096 }, tok);
    check(bad.code === 400, 'a cap that is not offered is refused');
    const set = await req('POST', '/api/memory', { mb: 2048 }, tok);
    check(set.code === 200 && set.body.memory.capMb === 2048 && fs.readFileSync(path.join(CG, 'memory.limit_in_bytes'), 'utf8') === String(2048 * 1048576), '2048 MB: set at once on the cgroup');
    check(JSON.parse(fs.readFileSync(path.join(STATE, 'settings.json'), 'utf8')).memMb === 2048, 'and kept in the settings');
    oom(1);
    const m1 = await until('the kill reported', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.memory && r.body.memory.note ? r.body.memory : null)), 6000);
    check(!!m1 && /out of memory: the page needed more than the 2048 MB cap/.test(m1.note) && !!m1.oomAt, 'a process killed at the cap is reported (' + (m1 && m1.note) + ')');
    check(lines.some((l) => /memory: Chromium hit its 2048 MB cap/.test(l)), 'and logged');
    const three = await req('POST', '/api/memory', { mb: 3072 }, tok);
    check(three.code === 200 && three.body.memory.capMb === 3072, '3 GB is offered');
    await req('POST', '/api/memory', { mb: 1536 }, tok);

    /* close to the cap (not counting reclaimable file pages): Chromium is asked to free memory */
    fs.writeFileSync(path.join(CG, 'memory.stat'), ['total_rss 1400000000', 'total_inactive_file 0', ''].join('\n'));
    fs.writeFileSync(path.join(CG, 'memory.usage_in_bytes'), String(1450 * 1048576));
    await until('asked to free memory near the cap', () => lines.some((l) => /memory: 1450 of 1536 MB in use: asked Chromium to free memory/.test(l)), 6000);
    const mp = await req('GET', '/api/status', undefined, tok);
    check(mp.body.memory.purges >= 1 && mp.body.memory.workMb === 1450 && mp.body.browser === 'running', 'near the cap Chromium is asked to free memory, and keeps running (' + mp.body.memory.purges + ')');
    fs.writeFileSync(path.join(CG, 'memory.stat'), ['total_inactive_file ' + (800 * 1048576), ''].join('\n'));
    const n1 = lines.length;
    await wait(3000);
    check(!lines.slice(n1).some((l) => /asked Chromium to free memory/.test(l)), 'reclaimable file pages do not count (1450 MB used, 650 not cache)');
    fs.writeFileSync(path.join(CG, 'memory.usage_in_bytes'), String(700 * 1048576));

    /* make room: Moonlight paused (on recmgr's list at boot), Cast left (half listed), both back when off */
    const ro = await req('POST', '/api/room', { on: true }, tok);
    check(ro.code === 200, '/api/room on');
    const r1 = await until('Moonlight paused', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.room.paused.join() === 'vizualyse-moonlight' && r.body.room.note ? r.body.room : null)), 8000);
    const calls = () => fs.readFileSync('/dev/shm/systemctl.log', 'utf8');
    check(/stop vizualyse-moonlight\.service/.test(calls()) && !/stop vizualyse-cast/.test(calls()), 'Moonlight is stopped; Cast, not loaded by recmgr in both lists, is not');
    check(!!r1 && /vizualyse-cast left running: recmgr did not load it/.test(r1.note), 'and the app is told why (' + (r1 && r1.note) + ')');
    const pj = JSON.parse(fs.readFileSync(path.join(STATE, 'paused.json'), 'utf8'));
    check(pj.units.join() === 'vizualyse-moonlight' && !!pj.boot, 'what it paused is kept with the boot');
    await req('POST', '/api/room', { on: false }, tok);
    await until('Moonlight started again', () => /start vizualyse-moonlight\.service/.test(calls()) && fs.existsSync('/dev/shm/units/vizualyse-moonlight.service'), 8000);
    const r2 = await req('GET', '/api/status', undefined, tok);
    check(r2.body.room.paused.length === 0 && !r2.body.room.on, 'make room off: Moonlight runs again, nothing paused');

    const go = await req('POST', '/api/go', { url: 'http://127.0.0.1:8999/' }, tok);
    check(go.code === 200, '/api/go opens the page');
    await until('the page loads', () => req('GET', '/api/status', undefined, tok).then((r) => r.body.title === 'start'), 15000);

    fs.writeFileSync(RLOG, '');
    const c = await until('the control socket', () => ctl(), 5000);
    c.send({ cmd: 'speed', kmh: 0 });
    c.send({ cmd: 'show' });
    await until('it is shown', () => c.last() && c.last().shown, 10000);
    await wait(2000);
    const rl = fs.readFileSync(RLOG, 'utf8');
    check(/place 1790x638\+108\+82/.test(rl), 'placed in the app area');
    check(/video 1 \/dev\/shm\/mgu-video-vizualyse_chromium/.test(rl) && /show true/.test(rl), 'the frame file is shown');
    const buf = fs.readFileSync(FRAME);
    const W = buf.readUInt32LE(8), H = buf.readUInt32LE(12), seq = buf.readUInt32LE(16), slot = buf.readUInt32LE(20);
    check(W === 1790 && H === 638 && seq > 0, 'pictures reach the frame file (' + W + 'x' + H + ', seq ' + seq + ')');
    const pic = buf.slice(64 + slot * W * H * 3 / 2);
    const V = (x, y) => pic[W * H + (W * H >> 2) + (y >> 1) * (W >> 1) + (x >> 1)];
    const U = (x, y) => pic[W * H + (y >> 1) * (W >> 1) + (x >> 1)];
    check(V(100, 400) > 200 && U(1700, 400) > 200, 'the page\'s red and blue halves are in it');

    touchFile(108 + 320, 82 + 120);
    await until('a touch in the area presses the button', () => req('GET', '/api/status', undefined, tok).then((r) => r.body.title === 'tapped 1'), 5000);
    await wait(500);
    touchFile(50, 300);   /* the HMI's left strip */
    await wait(1500);
    const after = await req('GET', '/api/status', undefined, tok);
    check(after.body.title === 'tapped 1', 'a touch outside the area is left to the HMI (title ' + after.body.title + ')');

    /* the resolution, live while shown: half the pixels, the same place, the same touches */
    const sc = await req('POST', '/api/scale', { scale: 0.5 }, tok);
    check(sc.code === 200 && sc.body.scale === 0.5 && sc.body.resolutions.length === 5, '/api/scale 0.5');
    const half = await until('pictures at half size', () => {
        const b = fs.readFileSync(FRAME);
        return b.readUInt32LE(8) === 892 && b.readUInt32LE(12) === 316 && b.readUInt32LE(16) > 0 ? b : null;
    }, 10000);
    if (half) {
        const w2 = 892, h2 = 316, sl = half.readUInt32LE(20);
        const p2 = half.slice(64 + sl * w2 * h2 * 3 / 2);
        const V2 = (x, y) => p2[w2 * h2 + (w2 * h2 >> 2) + (y >> 1) * (w2 >> 1) + (x >> 1)];
        const U2 = (x, y) => p2[w2 * h2 + (y >> 1) * (w2 >> 1) + (x >> 1)];
        check(V2(50, 200) > 200 && U2(850, 200) > 200, 'the page at half size: red and blue halves, the same layout');
    }
    const places = fs.readFileSync(RLOG, 'utf8').split(/\r?\n/).filter((l) => /place/.test(l));
    check(/place 1790x638\+108\+82/.test(places[places.length - 1] || ''), 'still placed over the whole app area, mgu-render scales it up (' + places[places.length - 1] + ')');
    check(JSON.parse(fs.readFileSync(path.join(STATE, 'settings.json'), 'utf8')).scale === 0.5, 'the resolution is kept in the settings');
    touchFile(108 + 320, 82 + 120);
    await until('a touch at half resolution presses the same button', () => req('GET', '/api/status', undefined, tok).then((r) => r.body.title === 'tapped 2'), 5000);
    const bad2 = await req('POST', '/api/scale', { scale: 0.3 }, tok);
    check(bad2.code === 400, 'a resolution that is not offered is refused');
    await req('POST', '/api/scale', { scale: 1 }, tok);
    await until('full size again', () => { const b = fs.readFileSync(FRAME); return b.readUInt32LE(8) === 1790 && b.readUInt32LE(16) > 0; }, 10000);

    c.send({ cmd: 'speed', kmh: 20 });
    await until('driving hides it', () => c.last() && !c.last().shown && c.last().moving, 5000);
    c.send({ cmd: 'show' });
    await wait(500);
    check(c.errors.indexOf('not while driving') >= 0, '"show" is refused while driving');
    c.send({ cmd: 'speed', kmh: 0 });
    c.send({ cmd: 'show' });
    await until('parked again it shows', () => c.last() && c.last().shown, 5000);
    c.send({ cmd: 'hide' });
    await until('"hide" hides it', () => c.last() && !c.last().shown, 5000);
    check(!fs.existsSync(FRAME), 'the frame file is gone once hidden');

    /* the GPU mode from the app: Chromium restarts on the unit's Mesa 19; with
     * no GPU here the probe finds SwiftShader and it goes back to the CPU */
    const n0 = lines.length;
    c.send({ cmd: 'gpu', on: true });
    await until('"gpu" turns the GPU mode on', () => c.last() && c.last().gpuMode === true, 5000);
    const back = await until('without a GPU it goes back to the CPU', () => {
        const s = c.last();
        return s && s.gpuMode === false && s.browser === 'running' && s.gpu && s.gpu.mode === 'cpu' && /did not start/.test(s.gpuNote || '') ? s : null;
    }, 120000);
    const gl = lines.slice(n0);
    check(gl.some((l) => /GPU mode: ANGLE on the unit's Mesa 19/.test(l)), 'Chromium ran in the GPU mode');
    check(gl.some((l) => /egl-shim: \/usr\/lib\/libEGL\.so\.1 loaded/.test(l)), 'through the EGL shim');
    check(gl.some((l) => /@gpu .*"mode":"gpu"/.test(l)), 'the GPU mode was probed');
    check(!!back && !fs.existsSync(path.join(STATE, 'gpu-trial')), 'the GPU try ended cleanly (no gpu-trial left)');
    if (back) console.log('     ' + back.gpuNote);
    const refused = await req('POST', '/api/gpu', { on: false }, tok);
    check(refused.code === 200 && refused.body.gpuMode === false, '/api/gpu off when it is off: nothing to do');

    /* game mode from the app: Chromium restarts with Dawn's checks off (that
     * the switch really skips validation: knowledge/browser.md, "Game mode") */
    const dawn = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).some((p) => {
        try { return /\/chromium\0(?:[^\0]*\0)*--enable-dawn-features=skip_validation,disable_robustness\0/.test(fs.readFileSync('/proc/' + p + '/cmdline', 'utf8')); } catch (e) { return false; }
    });
    check(!dawn(), 'without game mode Chromium keeps Dawn\'s checks');
    c.send({ cmd: 'game', on: true });
    await until('"game" turns game mode on', () => c.last() && c.last().gameMode === true, 5000);
    await until('Chromium runs again in game mode', () => c.last() && c.last().browser === 'running' && dawn(), 60000);
    check(dawn(), 'game mode: Chromium runs with --enable-dawn-features=skip_validation,disable_robustness');
    c.send({ cmd: 'game', on: false });
    await until('game mode off: Chromium runs without it', () => c.last() && c.last().gameMode === false && c.last().browser === 'running' && !dawn(), 60000);
    check(true, 'game mode off: Chromium runs with Dawn\'s checks again');

    c.send({ cmd: 'disable' });
    await until('"disable" stops Chromium', () => c.last() && c.last().browser === 'off' && !c.last().enabled, 10000);
    c.send({ cmd: 'enable' });
    await until('"enable" starts it again', () => c.last() && c.last().browser === 'running', 60000);
    c.close();

    srv.kill('SIGTERM');
    await wait(3000);
    site.close();
    if (fails || process.env.VERBOSE) console.log(lines.slice(-50).join('\n'));
    console.log(fails ? fails + ' FAILED' : 'all ok');
    process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
