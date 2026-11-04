// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The CarPlay second screen as a source (src/carplay_screen.js, server.js).
 * Node 8, as the head unit; the static ffmpeg the kit ships (build/ffmpeg,
 * `node tools/fetch_ffmpeg.js`) for the stream parts. Off the car: hook111 is
 * a fake run directory, its sink a socket sending x264's Annex-B as the hook
 * does.
 *
 *   FFMPEG=build/ffmpeg node test/carplay_test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const HERE = path.join(__dirname, '..');
const FFMPEG = path.resolve(process.env.FFMPEG || path.join(HERE, 'build', 'ffmpeg'));
let failed = 0;
function ok(name, cond) { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) failed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), n)); }

/* a fake hook111 run directory */
function fakeRun(o) {
    const run = tmpdir('hook111-');
    if (o.armed) fs.writeFileSync(path.join(run, 'env'), 'LD_PRELOAD="/usr/lib/libschedconfig.so.1 /var/opt/hook111/current/libhook111.so"\n' + (o.port ? 'HOOK111_SINK_PORT=' + o.port + '\n' : ''));
    if (o.mode) fs.writeFileSync(path.join(run, 'mode'), o.mode + '\n');
    fs.mkdirSync(path.join(run, 'log'));
    if (o.status) fs.writeFileSync(path.join(run, 'log', 'status'), Object.keys(o.status).map((k) => k + '=' + o.status[k]).join('\n') + '\n');
    if (o.fallback) fs.writeFileSync(path.join(run, 'log', 'fallback'), 'off\n');
    return run;
}

/* a fake hook111 install: its config folder and an arm step whose `mode`
 * writes the run directory's mode file when armed, as hook111-arm.sh does */
function fakeInstall(run, config) {
    const v = tmpdir('hook111-var-');
    if (config !== undefined) fs.writeFileSync(path.join(v, 'config'), config);
    const arm = path.join(v, 'hook111-arm.sh');
    const r = run.replace(/\\/g, '/');
    fs.writeFileSync(arm, '#!/bin/sh\n[ "$1" = mode ] && [ -e "' + r + '/env" ] && echo "$2" >"' + r + '/mode"\nexit 0\n');
    return { run: run, varDir: v, arm: arm };
}

function modes(cp) {
    const cfg = (o) => fs.readFileSync(path.join(o.varDir, 'config'), 'utf8');
    const modeNow = (o) => fs.readFileSync(path.join(o.run, 'mode'), 'utf8').trim();
    let o = fakeInstall(fakeRun({ armed: true, mode: 'off' }), 'HOOK111_SINK_PORT=6111\nHOOK111_MODE=off\n');
    let sw = cp.switchState(o);
    ok('switch: installed, off', sw.installed && !sw.on && sw.pending === null);
    let r = cp.setMode('alt', o);
    ok('mode alt while armed: set for this start through the arm step, from the phone\'s next connection',
        r.now && /next connection/.test(r.note) && modeNow(o) === 'alt');
    ok('... saved as HOOK111_MODE=alt, the config\'s other lines kept, one mode line', cfg(o) === 'HOOK111_SINK_PORT=6111\nHOOK111_MODE=alt\n');
    sw = cp.switchState(o);
    ok('switch: on, waiting for the phone (not streaming yet)', sw.on && /next connection/.test(sw.pending));
    ok('state: ready in alt', cp.state(o.run).ready);
    r = cp.setMode('off', o);
    ok('mode off: set now and saved', r.now && modeNow(o) === 'off' && /HOOK111_MODE=off\n$/.test(cfg(o)));
    let threw = null;
    try { cp.setMode('full', o); } catch (e) { threw = e.message; }
    ok('mode full is not offered (the phone refused every session with it)', !!threw && /off or alt/.test(threw) && /HOOK111_MODE=off\n$/.test(cfg(o)));

    o = fakeInstall(fakeRun({}));
    r = cp.setMode('alt', o);
    ok('not armed this start: saved (a new config), from the next start', !r.now && /next start/.test(r.note) && cfg(o) === 'HOOK111_MODE=alt\n' &&
        !fs.existsSync(path.join(o.run, 'mode')));
    sw = cp.switchState(o);
    ok('switch: on, from the next start', sw.on && sw.pending === 'from the next start');

    o = fakeInstall(fakeRun({ armed: true, mode: 'alt', fallback: true }), 'HOOK111_MODE=alt\n');
    r = cp.setMode('alt', o);
    ok('fell back this start: alt only from the next start', !r.now && /fell back/.test(r.note));

    o = fakeInstall(fakeRun({ armed: true, mode: 'off' }));
    fs.unlinkSync(o.arm);
    threw = null;
    try { cp.setMode('alt', o); } catch (e) { threw = e.message; }
    ok('hook111 not installed: refused, nothing saved', !!threw && /not installed/.test(threw) && !fs.existsSync(path.join(o.varDir, 'config')));
    ok('switch: not installed', !cp.switchState(o).installed);
    ok('saved mode: off without a config line; the last line wins', cp.savedMode(tmpdir('v-')) === 'off' &&
        cp.savedMode(fakeInstall(fakeRun({}), 'HOOK111_MODE=alt\nHOOK111_MODE=off\n').varDir) === 'off');

    /* hook111's real arm step (native/hook111), under a fake root */
    const real = path.join(HERE, '..', 'hook111', 'hook111-arm.sh');
    if (!fs.existsSync(real)) { console.log('skip the real arm step: no ' + real); return; }
    const root = tmpdir('hook111-root-'), run = path.join(root, 'run', 'hook111');
    fs.mkdirSync(path.join(root, 'run')); fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, 'env'), 'LD_PRELOAD="/var/opt/hook111/current/libhook111.so"\n');
    fs.writeFileSync(path.join(run, 'mode'), 'off\n');
    process.env.HOOK111_ROOT = root;
    try {
        r = cp.setMode('alt', { run: run, varDir: tmpdir('hook111-var-'), arm: real });
        ok('the real hook111-arm.sh sets the mode for this start', r.now && fs.readFileSync(path.join(run, 'mode'), 'utf8').trim() === 'alt');
    } finally { delete process.env.HOOK111_ROOT; }
}

function unit() {
    const cp = require(path.join(HERE, 'src', 'carplay_screen.js'));
    let s = cp.state(tmpdir('none-'));
    ok('no hook111: not armed, not ready, says why', !s.armed && !s.ready && /not armed/.test(s.why));
    s = cp.state(fakeRun({ armed: true, mode: 'off' }));
    ok('armed in mode off: not ready (alt streams)', s.armed && !s.ready && /mode off/.test(s.why));
    s = cp.state(fakeRun({ armed: true, mode: 'alt', status: { screen_b: 'up', b_frames: 4520, display: '1088x480@30' } }));
    ok('armed in mode alt: ready; streaming, frames and display from its status', s.ready && s.streaming && s.frames === 4520 && s.display === '1088x480@30' && s.port === 6111);
    s = cp.state(fakeRun({ armed: true, mode: 'alt', fallback: true }));
    ok('fell back (the phone refused): not ready', !s.ready && /fell back/.test(s.why));
    s = cp.state(fakeRun({ armed: true, mode: 'alt', port: 6222 }));
    ok('the sink port from its env file', s.port === 6222);

    const run = fakeRun({ armed: true, mode: 'alt', status: { display: '1088x480@30' } });
    let d = cp.wantDisplay('map', run);
    ok('map: asks for 1088x480@30, already what the phone has', d.wanted === '1088x480@30' && !d.pending && fs.readFileSync(path.join(run, 'display'), 'utf8') === '1088x480@30\n');
    d = cp.wantDisplay('hud', run);
    ok('hud: asks for 1056x384@30, pending until the phone reconnects', d.wanted === '1056x384@30' && d.pending && cp.state(run).wanted === '1056x384@30');
    ok('no hook111 run directory: nothing written', cp.wantDisplay('map', path.join(run, 'nope')) === null);
    ok('an unknown target: nothing written', cp.wantDisplay('console', run) === null);

    ['map', 'hud'].forEach((t) => {
        const T = cp.TARGETS[t], kbs = T.w * T.h * 1.5 * T.fps / 1024;
        ok(t + ': ' + T.w + 'x' + T.h + ' at ' + T.fps + ' fps, a multiple of 4 wide, ' + Math.round(kbs) + ' KB/s (renderer: 5500)', T.w % 4 === 0 && T.h % 2 === 0 && kbs < 5500);
    });
    const hud = cp.TARGETS.hud;
    ok('hud: the frame is the visible band (17-83 % x 25-65 % of 800x480)', hud.w === Math.round(800 * 0.66) && hud.h === Math.round(480 * 0.40));
    const ia = cp.inputArgs(6111).join(' ');
    ok('input: listens on 127.0.0.1:6111 for raw H.264, a small probe, not nobuffer (it drops every frame)',
        /-f h264 -i tcp:\/\/127\.0\.0\.1:6111\?listen=1/.test(ia) && /-analyzeduration 0/.test(ia) && !/nobuffer/.test(ia));
    return cp;
}

/* an x264 stream as the hook's sink sends it: Annex-B, SPS/PPS before the IDR */
function makeStream(w, h, secs) {
    const f = path.join(tmpdir('h264-'), w + 'x' + h + '.h264');
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=' + w + 'x' + h + ':rate=16', '-t', String(secs),
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-x264-params', 'keyint=1000:repeat-headers=1', '-f', 'h264', f]);
    return f;
}

function connectWhenListening(port, tries) {
    return new Promise((resolve, reject) => {
        const go = (n) => {
            const s = net.connect(port, '127.0.0.1');
            s.once('connect', () => resolve(s));
            s.once('error', () => { s.destroy(); if (n <= 0) reject(new Error('nothing listens on ' + port)); else setTimeout(() => go(n - 1), 100); });
        };
        go(tries);
    });
}

/* ffmpeg with the tool's own arguments: the stream in, I420 frames out */
async function throughFfmpeg(cp, target, stream, port) {
    const T = cp.TARGETS[target], size = T.w * T.h * 3 / 2;
    const ff = spawn(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error'].concat(cp.inputArgs(port), cp.outputArgs(target)), { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, err = '';
    ff.stdout.on('data', (b) => { bytes += b.length; });
    ff.stderr.on('data', (b) => { err += b; });
    const sock = await connectWhenListening(port, 50);
    sock.end(fs.readFileSync(stream));
    const code = await new Promise((r) => ff.on('exit', r));
    return { frames: bytes / size, whole: bytes % size === 0, code: code, err: err.trim() };
}

async function streams(cp) {
    const cluster = makeStream(1088, 480, 3), hudSize = makeStream(1056, 384, 3);
    let r = await throughFfmpeg(cp, 'map', cluster, 46201);
    ok('map: a 1088x480 stream -> ' + r.frames + ' whole 816x360 frames, ffmpeg clean', r.whole && r.frames >= 30 && r.code === 0 && !r.err);
    r = await throughFfmpeg(cp, 'hud', hudSize, 46202);
    ok('hud: a 1056x384 stream -> ' + r.frames + ' whole 528x192 frames', r.whole && r.frames >= 40 && r.code === 0 && !r.err);
    r = await throughFfmpeg(cp, 'hud', cluster, 46203);
    ok('hud while the phone is still on 1088x480: scaled to fit (' + r.frames + ' frames)', r.whole && r.frames >= 40 && r.code === 0);
    return cluster;
}

/* server.js itself, with a fake hook111 and no renderer */
function get(port, p, token) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: port, path: p, headers: { 'X-Cast-Token': token } }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
        }).on('error', reject);
    });
}
function post(port, p, token, obj) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: port, path: p, method: 'POST', headers: { 'X-Cast-Token': token, 'Content-Type': 'application/json' } }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode, body: b }));
        });
        req.on('error', reject); req.end(JSON.stringify(obj));
    });
}
function ctl(sockPath, cmd) {
    return new Promise((resolve, reject) => {
        const s = net.connect(sockPath), lines = [];
        let buf = '';
        s.setEncoding('utf8');
        s.on('connect', () => s.write(JSON.stringify(cmd) + '\n'));
        s.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } if (lines.length >= 2) { s.destroy(); resolve(lines); } });
        s.on('error', reject);
        setTimeout(() => { s.destroy(); resolve(lines); }, 2000);
    });
}

async function server(cluster) {
    const state = tmpdir('cast-state-'), run = fakeRun({ armed: true, mode: 'off' }), PORT = 18480;
    const inst = fakeInstall(run);
    const sock = path.join(tmpdir('cast-ctl-'), 'ctl.sock');
    const logs = [];
    const srv = spawn(process.execPath, [path.join(HERE, 'src', 'server.js')], {
        env: Object.assign({}, process.env, { CAST_STATE: state, CAST_PORT: String(PORT), CAST_CTL_SOCKET: sock, CAST_HOOK_RUN: run, CAST_HOOK_VAR: inst.varDir, CAST_HOOK_ARM: inst.arm, CAST_FFMPEG: FFMPEG }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    srv.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l && logs.push(l)));
    srv.stderr.on('data', (d) => String(d).split('\n').forEach((l) => l && logs.push(l)));
    try {
        let token = null;
        for (let i = 0; i < 50 && !token; i++) { await sleep(100); try { token = fs.readFileSync(path.join(state, 'token'), 'utf8').trim(); } catch (e) { /* not yet */ } }
        let st = null;
        for (let i = 0; i < 50 && !st; i++) { await sleep(100); try { const r = await get(PORT, '/api/status', token); if (r.code === 200) st = JSON.parse(r.body); } catch (e) { /* not yet */ } }
        ok('server: up; status has the CarPlay second screen, nothing of the mirror', st && st.carplay && st.carplay.armed === true && st.carplay.ready === false &&
            !('crops' in st) && !('screen' in st) && !('screenSize' in st) && !('crop' in st));
        ok('server: no screen snapshot any more', (await get(PORT, '/api/screen.jpg', token)).code === 404);
        let r = await post(PORT, '/api/play', token, { source: 'carplay', output: 'map' });
        ok('play the second screen with hook111 in mode off: refused, says why', r.code === 400 && /mode off/.test(JSON.parse(r.body).error));
        const c0 = await ctl(sock, { cmd: 'carplay', output: 'hud' });
        ok('control socket, carplay while not ready: an error', c0.some((l) => l.ev === 'error' && /not available/.test(l.error)));

        ok('status: the switch, installed and off', st.carplay.switch && st.carplay.switch.installed === true && st.carplay.switch.on === false);
        r = await post(PORT, '/api/hook111', token, { mode: 'full' });
        ok('the phone page: mode full refused', r.code === 400 && /off or alt/.test(JSON.parse(r.body).error));
        r = await post(PORT, '/api/hook111', token, { mode: 'alt' });
        st = r.code === 200 && JSON.parse(r.body);
        ok('the phone page turns the second screen on: alt now and saved', st && st.carplay.switch.on && st.carplay.ready &&
            fs.readFileSync(path.join(run, 'mode'), 'utf8').trim() === 'alt' && fs.readFileSync(path.join(inst.varDir, 'config'), 'utf8') === 'HOOK111_MODE=alt\n');
        r = await post(PORT, '/api/play', token, { source: 'carplay', output: 'map' });
        st = r.code === 200 && JSON.parse(r.body);
        ok('play the second screen in mode alt: playing on the cluster map', st && st.state === 'playing' && st.output === 'map' && st.source === 'carplay');
        ok('it asked hook111 for the cluster size', fs.readFileSync(path.join(run, 'display'), 'utf8').trim() === '1088x480@30');
        const s = await connectWhenListening(6111, 50);
        s.end(fs.readFileSync(cluster));
        let frames = 0;
        for (let i = 0; i < 60 && frames < 30; i++) { await sleep(100); frames = JSON.parse((await get(PORT, '/api/status', token)).body).frames || frames; }
        ok('the hook\'s stream reaches the cluster layer: ' + frames + ' frames', frames >= 30);
        let again = false;
        for (let i = 0; i < 40 && !again; i++) { await sleep(100); again = logs.filter((l) => /play: CarPlay second screen on map/.test(l)).length >= 2; }
        ok('after the connection ends, ffmpeg listens again', again);
        const back = await connectWhenListening(6111, 50);
        back.destroy();
        ok('... and takes the next connection', true);

        const c1 = await ctl(sock, { cmd: 'carplay', output: 'hud' });
        await sleep(300);
        st = JSON.parse((await get(PORT, '/api/status', token)).body);
        ok('control socket, carplay hud: playing on the HUD, asked for 1056x384', c1.length >= 1 && st.output === 'hud' && st.state === 'playing' &&
            fs.readFileSync(path.join(run, 'display'), 'utf8').trim() === '1056x384@30');
        r = await post(PORT, '/api/stop', token, {});
        await sleep(1500);
        st = JSON.parse((await get(PORT, '/api/status', token)).body);
        ok('stop: idle, and no listening again after a stop', st.state === 'idle' && logs.filter((l) => /play: CarPlay second screen on hud/.test(l)).length === 1);
        await ctl(sock, { cmd: 'carplay', output: 'map' });
        await sleep(300);
        const c2 = await ctl(sock, { cmd: 'hook111', mode: 'off' });
        await sleep(300);
        st = JSON.parse((await get(PORT, '/api/status', token)).body);
        ok('control socket, hook111 off: no error, the playing second screen stops, off now and saved', !c2.some((l) => l.ev === 'error') &&
            st.state !== 'playing' && !st.carplay.ready && !st.carplay.switch.on &&
            fs.readFileSync(path.join(run, 'mode'), 'utf8').trim() === 'off' && fs.readFileSync(path.join(inst.varDir, 'config'), 'utf8') === 'HOOK111_MODE=off\n');
        r = await post(PORT, '/api/play', token, { source: 'screen', output: 'map' });
        ok('the old central-screen source is gone (treated as a URL, refused)', r.code === 400);
    } finally {
        srv.kill('SIGTERM');
        await new Promise((res) => { srv.on('exit', res); setTimeout(res, 3000); });
    }
    if (failed) console.log(logs.slice(-30).join('\n'));
}

(async () => {
    const cp = unit();
    modes(cp);
    if (!fs.existsSync(FFMPEG)) { console.log('skip streams and server: no ffmpeg at ' + FFMPEG + ' (node tools/fetch_ffmpeg.js)'); }
    else { const cluster = await streams(cp); await server(cluster); }
    console.log(failed ? failed + ' FAILED' : 'all carplay tests passed');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
