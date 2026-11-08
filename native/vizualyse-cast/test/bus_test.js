// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Cast and the other tools' asks (platform tool/mqtt_bus): server.js
 * against the real broker (native/vizualyse-bus's Mosquitto, its own
 * mosquitto.conf), with a stand-in ffmpeg that only waits (a play stays
 * "playing"), no renderer, as root on Node 8 (native/vizualyse-bus/test/run_test.sh).
 * Another tool's ask for cluster-video off pauses a play on the cluster map
 * and its going starts it again; the HUD is its own name; a stop forgets a
 * paused play.
 *
 *   MOSQUITTO=... MOSQUITTO_CONF=... node native/vizualyse-cast/test/bus_test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HERE = path.join(__dirname, '..');
const { Bus, SOCKET } = require(path.join(HERE, 'src', 'mqtt_bus.js'));
const PORT = 18489;
let failed = 0;
function ok(what, cond, more) {
    console.log((cond ? '  ok   ' : '  FAIL ') + what + (more ? ' (' + more + ')' : ''));
    if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await check()) return true;
    return check();
}
function req(method, p, token, obj) {
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method, headers: { 'X-Cast-Token': token, 'Content-Type': 'application/json' } }, (res) => {
            let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve({ code: res.statusCode, body: b }); } });
        });
        r.on('error', reject);
        r.end(obj ? JSON.stringify(obj) : undefined);
    });
}

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-bus-'));
    /* the broker, as systemd starts it */
    try { fs.mkdirSync(path.dirname(SOCKET), 0o700); } catch (e) { /* there */ }   /* Node 8: no recursive */
    const broker = spawn(process.env.MOSQUITTO, ['-c', process.env.MOSQUITTO_CONF], { stdio: 'ignore' });
    await until(() => fs.existsSync(SOCKET), 5000);
    /* ffmpeg that plays forever and draws nothing; and the ffmpegs alive */
    const ff = path.join(tmp, 'ffmpeg');
    fs.writeFileSync(ff, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 });
    /* the stand-in ffmpegs running (/proc: the unit's busybox may have no pgrep) */
    const ffmpegs = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
        try { return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8') === 'sleep\u0000600\u0000'; } catch (e) { return false; }
    }).length;

    const logs = [];
    const cast = spawn(process.execPath, [path.join(HERE, 'src', 'server.js')], {
        env: Object.assign({}, process.env, { CAST_STATE: path.join(tmp, 'state'), CAST_PORT: String(PORT), CAST_CTL_SOCKET: path.join(tmp, 'ctl.sock'),
            CAST_HOOK_RUN: path.join(tmp, 'hook-run'), CAST_HOOK_VAR: path.join(tmp, 'hook-var'), CAST_FFMPEG: ff }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    cast.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l && logs.push(l)));
    cast.stderr.on('data', (d) => String(d).split('\n').forEach((l) => l && logs.push(l)));
    const steam = new Bus('vizualyse-steam');
    try {
        let token = null;
        await until(() => { try { token = fs.readFileSync(path.join(tmp, 'state', 'token'), 'utf8').trim(); } catch (e) { /* not yet */ } return !!token; }, 5000);
        let st = null;
        await until(async () => { try { st = await req('GET', '/api/status', token); return st && st.bus && st.bus.connected; } catch (e) { return false; } }, 9000);
        ok('Cast is up and on the bus', st && st.bus && st.bus.connected, JSON.stringify(st && st.bus));
        await until(() => steam.connected, 9000);

        st = await req('POST', '/api/play', token, { url: 'http://192.0.2.1/live.ts', output: 'map', audio: false });
        ok('a stream plays on the cluster map', st.state === 'playing' && st.output === 'map' && ffmpegs() === 1, st.state + ', ' + ffmpegs() + ' ffmpeg');

        steam.ask({ 'cluster-video': 'off', 'hud-video': 'off' }, 'TestGame is running');
        ok('Steam asks for the cluster\'s video off: Cast pauses it (its ffmpeg stopped), and says why',
            await until(async () => { st = await req('GET', '/api/status', token); return st.state === 'paused' && ffmpegs() === 0; }, 5000),
            st.state + ': ' + st.note + ', ' + ffmpegs() + ' ffmpeg');
        ok('... naming who asks', /steam \(TestGame is running\)/.test(st.note || ''), st.note);

        steam.ask(null);
        ok('the ask goes: the stream plays again',
            await until(async () => { st = await req('GET', '/api/status', token); return st.state === 'playing' && ffmpegs() === 1; }, 5000),
            st.state + ', ' + ffmpegs() + ' ffmpeg');

        steam.ask({ 'cluster-video': 'off' }, 'TestGame is running');
        await until(async () => (await req('GET', '/api/status', token)).state === 'paused', 5000);
        st = await req('POST', '/api/play', token, { url: 'http://192.0.2.1/other.ts', output: 'hud', audio: false });
        ok('the HUD is its own name: a play there goes on while only the cluster\'s is asked off', st.state === 'playing' && st.output === 'hud' && ffmpegs() === 1);
        st = await req('POST', '/api/play', token, { url: 'http://192.0.2.1/third.ts', output: 'map', audio: false });
        ok('a play started on the cluster map while asked off waits, paused', st.state === 'paused' && ffmpegs() === 0, st.state);
        st = await req('POST', '/api/stop', token, {});
        ok('a stop forgets the paused play', st.state === 'idle', st.state);
        steam.ask(null);
        await sleep(1500);
        st = await req('GET', '/api/status', token);
        ok('... so the ask going starts nothing', st.state === 'idle' && ffmpegs() === 0, st.state + ', ' + ffmpegs() + ' ffmpeg');

        /* Steam dies during a game: its last will clears the ask */
        await req('POST', '/api/play', token, { url: 'http://192.0.2.1/live.ts', output: 'map', audio: false });
        const child = spawn(process.execPath, ['-e', 'const { Bus } = require(' + JSON.stringify(path.join(HERE, 'src', 'mqtt_bus.js')) + ');' +
            'const b = new Bus("vizualyse-steam"); b.on("connected", () => b.ask({ "cluster-video": "off" }, "a game"));'], { stdio: 'ignore' });
        await until(async () => (await req('GET', '/api/status', token)).state === 'paused', 7000);
        child.kill('SIGKILL');
        ok('Steam killed during a game: the stream plays again (the broker clears its ask)',
            await until(async () => (await req('GET', '/api/status', token)).state === 'playing', 7000));
    } finally {
        steam.close();
        cast.kill('SIGTERM');
        await new Promise((r) => { cast.on('exit', r); setTimeout(r, 3000); });
        broker.kill('SIGTERM');
    }
    if (failed || process.env.VERBOSE) console.log(logs.filter((l) => /play:|bus:/.test(l)).join('\n'));
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('  FAIL ' + e.stack); process.exit(1); });
