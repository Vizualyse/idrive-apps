// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The Winston output end to end: server.js, Chromium and chromium-wl as the
 * unit runs them, against the head unit's own Winston running in the same
 * container (tools/winston-bench, llvmpipe: real pixels). Run by
 * run_winston_test.sh.
 *
 * - chromium-wl connects to Winston at start (status: connected);
 * - "Winston output" on (/api/winston), "show": the page (red and blue
 *   halves) is on Winston's centre screen in the app area, full colour, and
 *   no frame file is made; the status says so;
 * - "hide": gone from the screen; "show" again: back;
 * - the resolution 1/2: the smaller pictures still fill the app area;
 * - off: the next show goes through mgu-render (the stand-in) again;
 * - the tool's start: Winston output is off (never kept).
 *
 *   node winston_test.js <tool folder>
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const T = process.argv[2] || '/t';
const STATE = '/var/opt/vizualyse-chromium/state';
const FRAME = '/dev/shm/mgu-video-vizualyse_chromium';
const RLOG = '/dev/shm/render.log';
const CTL = '/dev/shm/vizualyse-chromium/ctl.sock';
const GRAB = process.env.KMS_SHIM_GRAB || '/out/grab';
const AREA = { x: 108, y: 82, w: 1790, h: 638 };
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

function ctl() {
    return new Promise((resolve, reject) => {
        const s = net.connect(CTL, () => resolve({ send: (o) => s.write(JSON.stringify(o) + '\n'), last: () => s.lastStatus, close: () => s.destroy() }));
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev === 'status') s.lastStatus = m;
            }
        });
        s.on('error', reject);
    });
}

/* The centre screen as Winston composed it (kms_shim's read-back): RGB at x, y. */
function grab() {
    try { fs.unlinkSync(GRAB + '.ppm'); } catch (e) { /* none */ }
    try { execFileSync('/bench/wo_bench', ['grab'], { stdio: 'ignore', timeout: 10000 }); } catch (e) { return null; }
    const b = fs.readFileSync(GRAB + '.ppm');
    let off = 0, fields = [];
    while (fields.length < 4) {
        const end = b.indexOf(0x0a, off);
        fields = fields.concat(b.slice(off, end).toString().split(/\s+/).filter(Boolean));
        off = end + 1;
    }
    const w = Number(fields[1]);
    return (x, y) => { const i = off + (y * w + x) * 3; return [b[i], b[i + 1], b[i + 2]]; };
}
const red = (c) => c && c[0] > 200 && c[1] < 60 && c[2] < 60;
const blue = (c) => c && c[2] > 200 && c[0] < 60 && c[1] < 60;
const black = (c) => c && c[0] < 30 && c[1] < 30 && c[2] < 30;

/* the page: red / blue halves */
const PAGE = '<!doctype html><title>start</title><style>body{margin:0}#l,#r{position:fixed;top:0;bottom:0;width:50%}#l{left:0;background:#f00}#r{right:0;background:#00f}</style><div id=l></div><div id=r></div>';

async function main() {
    if (!fs.existsSync('/run/wayland/wayland-0')) { console.log('no Winston at /run/wayland/wayland-0: run through run_winston_test.sh'); process.exit(2); }
    http.createServer((q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(PAGE); }).listen(8999, '127.0.0.1');
    const srvEnv = Object.assign({}, process.env, {
        CHROMIUM_ARCHIVE: path.join(T, 'build/chromium.tgz'),
        CHROMIUM_RENDER_CLIENT: path.join(T, 'test/fake/render_client.js'),
        CHROMIUM_TEST_RENDER_LOG: RLOG,
        CHROMIUM_NO_FIREWALL: '1', CHROMIUM_NO_PROXY: '1', CHROMIUM_CGROUP_ROOT: '/dev/shm/cg',
        CHROMIUM_TOUCH_IFACE: '', CHROMIUM_TOUCH_FILE: '/dev/shm/no-touch', CHROMIUM_LINK_IP: '127.0.0.1',
        CHROMIUM_SYSTEMCTL: '/bin/true', CHROMIUM_RECMGR_INI: '/dev/shm/recmgr.ini', CHROMIUM_RECMGR_AT_BOOT: '/dev/shm/recmgr-at-boot.json',
        CHROMIUM_WINSTON: '/run/wayland/wayland-0',
    });
    delete srvEnv.LD_PRELOAD;   /* the bench's DRM shim: not for the browser */
    ['/dev/shm/cg', '/dev/shm/cg/vizualyse-chromium', '/var/opt', '/var/opt/vizualyse-chromium', STATE].forEach((d) => { try { fs.mkdirSync(d, 0o755); } catch (e) { /* there */ } });
    ['memory.oom_control', 'cgroup.procs', 'memory.usage_in_bytes', 'memory.max_usage_in_bytes'].forEach((f) => fs.writeFileSync('/dev/shm/cg/vizualyse-chromium/' + f, f === 'memory.oom_control' ? 'oom_kill 0\n' : '0'));
    fs.writeFileSync('/dev/shm/recmgr.ini', '[Whitelist]\n');
    const lines = [];
    const start = () => {
        const srv = spawn('/usr/bin/node', [path.join(T, 'src/server.js')], { env: srvEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        const keep = (d) => String(d).split('\n').filter(Boolean).forEach((l) => { lines.push(l); if (process.env.VERBOSE) console.log('  | ' + l); });
        srv.stdout.on('data', keep);
        srv.stderr.on('data', keep);
        return srv;
    };
    let srv = start();
    const tok = await until('the token is written', () => fs.readFileSync(path.join(STATE, 'token'), 'utf8').trim(), 10000);
    const st = await until('Chromium runs', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.browser === 'running' ? r.body : null)), 120000);
    if (!st) { console.log(lines.slice(-40).join('\n')); process.exit(1); }
    check(st.winston && st.winston.connected === true && st.winston.on === false, 'chromium-wl connected to Winston at start; the output is off');
    check(lines.some((l) => /display: ready .*Winston connected/.test(l)), 'the journal says so (' + (lines.find((l) => /display: ready/.test(l)) || '') + ')');

    await req('POST', '/api/go', { url: 'http://127.0.0.1:8999/' }, tok);
    await until('the page loads', () => req('GET', '/api/status', undefined, tok).then((r) => r.body.title === 'start'), 15000);

    const on = await req('POST', '/api/winston', { on: true }, tok);
    check(on.code === 200 && on.body.winston.on === true, '/api/winston on');
    fs.writeFileSync(RLOG, '');
    const c = await until('the control socket', () => ctl(), 5000);
    c.send({ cmd: 'speed', kmh: 0 });
    c.send({ cmd: 'show' });
    await until('it is shown', () => c.last() && c.last().shown, 10000);
    await wait(2500);
    const s1 = await req('GET', '/api/status', undefined, tok);
    check(s1.body.winston.via === 'winston', 'shown through Winston (status: ' + s1.body.winston.via + ')');
    check(!fs.existsSync(FRAME) && !/video 1/.test(fs.readFileSync(RLOG, 'utf8')), 'no frame file, nothing asked of mgu-render');
    let px = grab();
    check(!!px, 'Winston composed the screen');
    if (px) {
        const L = px(AREA.x + 200, AREA.y + 300), R = px(AREA.x + AREA.w - 200, AREA.y + 300), out = px(40, 300);
        check(red(L) && blue(R), 'the page is on the centre screen in the app area, full colour (left ' + L + ', right ' + R + ')');
        check(black(out), 'nothing outside the app area (' + out + ')');
        check(red(px(AREA.x + 2, AREA.y + 2)) && blue(px(AREA.x + AREA.w - 3, AREA.y + AREA.h - 3)), 'it fills the app area to its corners');
    }
    check(lines.some((l) => /screen: shown \(winston\)/.test(l)), 'the journal says how it is shown');

    c.send({ cmd: 'hide' });
    await until('hidden', () => c.last() && !c.last().shown, 5000);
    await wait(800);
    px = grab();
    check(!!px && black(px(AREA.x + 200, AREA.y + 300)) && black(px(AREA.x + AREA.w - 200, AREA.y + 300)), 'hidden: gone from the screen');
    c.send({ cmd: 'show' });
    await until('shown again', () => c.last() && c.last().shown, 5000);
    await wait(1500);
    px = grab();
    check(!!px && red(px(AREA.x + 200, AREA.y + 300)) && blue(px(AREA.x + AREA.w - 200, AREA.y + 300)), 'shown again: the page is back');

    await req('POST', '/api/scale', { scale: 0.5 }, tok);
    await wait(3000);
    px = grab();
    check(!!px && red(px(AREA.x + 200, AREA.y + 300)) && blue(px(AREA.x + AREA.w - 200, AREA.y + 300)) && red(px(AREA.x + 4, AREA.y + 4)),
        'at 1/2 the pictures (892x316) still fill the app area, Winston scales them');
    const sc = (lines.filter((l) => /display: stats|"src"/.test(l)).pop() || '');
    await req('POST', '/api/scale', { scale: 1 }, tok);

    const off = await req('POST', '/api/winston', { on: false }, tok);
    check(off.code === 200 && off.body.winston.on === false, '/api/winston off');
    await wait(2500);
    px = grab();
    const s2 = await req('GET', '/api/status', undefined, tok);
    check(s2.body.winston.via === 'mgu-render' && fs.existsSync(FRAME) && /video 1/.test(fs.readFileSync(RLOG, 'utf8')), 'off: shown through mgu-render (the frame file) again');
    check(!!px && black(px(AREA.x + 200, AREA.y + 300)), 'and our surface is gone from Winston');
    (void sc);

    /* a restart of the tool: off */
    await req('POST', '/api/winston', { on: true }, tok);
    c.close();
    srv.kill('SIGTERM');
    await wait(4000);
    srv = start();
    const st2 = await until('Chromium runs again', () => req('GET', '/api/status', undefined, tok).then((r) => (r.body.browser === 'running' ? r.body : null)), 120000);
    check(!!st2 && st2.winston.on === false, 'after a restart of the tool Winston output is off (never kept)');
    srv.kill('SIGTERM');
    await wait(2000);
    console.log(fails ? fails + ' FAILED' : 'all ok');
    process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
