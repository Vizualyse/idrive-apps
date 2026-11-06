// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool end to end in the head unit's own root filesystem (glibc 2.27,
 * Node 8.16, BusyBox, the unit's Mesa 19 in /usr/lib), no network:
 * test/run_unit_test.sh starts it. The GPU is the GPU bench's stand-in
 * (GPU=stub: the unit's own i965 on a fake HD 505, no pixels; GPU=swrast:
 * Mesa 19 llvmpipe through the unit's libEGL / libgbm, real pixels).
 *
 *   node unit_test.js /t        (/t: the tool's folder, /g: tools/gpu-bench/build)
 *
 * Covers: the three bundles unpack (the prefix the tool uid's); the phone's
 * DNS reaches the runtime's resolver file; the real DepotDownloader starts
 * on the runtime's .NET as uid 12996; a download through a stand-in
 * DepotDownloader (the real one's prompts): password, a wrong Steam Guard
 * code, the right one, progress, the game in the library with its program
 * found (not the redistributable); playing it (test/win/t_d3d9.c as the
 * game): Wine through Proton's launch, wl-sink, pictures in the frame file
 * (GPU buffers on the stub, the right colours on swrast); Stop ends every
 * process of the uid, the frame file and the running mark go; the iDrive
 * app's socket answers.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const T = process.argv[2] || '/t';
const GPU = process.env.GPU || 'stub';
const ROOT = '/var/opt/vizualyse-steam';
const UID = 12996;
const APP = 4242;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function ok(what, cond, more) {
    console.log((cond ? '  ok   ' : '  FAIL ') + what + (more ? ' (' + more + ')' : ''));
    if (!cond) failed++;
}

fs.writeFileSync('/tmp/lease.json', JSON.stringify({ ip: '127.0.0.1', dns: ['192.0.2.53'], router: '192.0.2.1' }));
/* T_LOG: the test program's own lines (test/win/tlog.h; steam.exe keeps its stdout) */
const T_LOG = '/tmp/t_d3d9.log';
const extra = { LD_PRELOAD: '/g/stub/libintel_noop_drm_shim.so', INTEL_STUB_GPU_PLATFORM: 'bxt', T_FRAMES: '100000',
    T_LOG: 'Z:' + T_LOG.replace(/\//g, '\\') };
const senv = Object.assign({}, process.env, {
    STEAM_NO_FIREWALL: '1', STEAM_LEASE: '/tmp/lease.json', STEAM_CTL_SOCKET: '/tmp/ctl/ctl.sock',
    STEAM_RUNTIME_ARCHIVE: T + '/build/runtime.tgz', STEAM_PROTON_ARCHIVE: T + '/build/proton.tgz',
    STEAM_PREFIX_ARCHIVE: T + '/build/prefix.tgz', STEAM_LAUNCH: T + '/build/launch.json',
    STEAM_DD_CMD: '/usr/bin/node ' + T + '/test/fake_dd.js ' + T + '/build/win/t_d3d964.exe',
    STEAM_RENDER_CLIENT: '/nonexistent/mgu_render_client.js', STEAM_LINK_IP: '127.0.0.1',
});
if (GPU === 'swrast') {
    extra.GBM_ALWAYS_SOFTWARE = '1';
    senv.STEAM_DRI_PATH = '/g/swrast';
    senv.STEAM_EXTRA_LIBS = '/g/swrast';
}
senv.STEAM_EXTRA_ENV = JSON.stringify(extra);

let server = null, serverLog = '';
function startServer() {
    server = spawn('/usr/bin/node', [T + '/src/server.js'], { env: senv, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (d) => { serverLog += d; if (process.env.VERBOSE) process.stdout.write(String(d).replace(/^/gm, '    | ')); };
    server.stdout.on('data', take);
    server.stderr.on('data', take);
}

let TOKEN = null;
function api(p, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: 8494, path: p, method: data ? 'POST' : 'GET',
            headers: { 'X-Steam-Token': TOKEN, 'Content-Type': 'application/json' } }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* text */ } resolve({ code: res.statusCode, body: j, text: b }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const status = () => api('/api/status').then((r) => r.body);
async function until(what, check, ms) {
    const end = Date.now() + ms;
    for (;;) {
        let s = null;
        try { s = await status(); } catch (e) { /* not yet */ }
        if (s && check(s)) return s;
        if (Date.now() > end) throw new Error('timed out waiting for ' + what + (s ? ': ' + JSON.stringify(s).slice(0, 600) : ''));
        await sleep(500);
    }
}

function uidProcesses(uid) {
    return fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((p) => {
        try { return new RegExp('^Uid:\\s+' + uid + '\\s', 'm').test(fs.readFileSync('/proc/' + p + '/status', 'utf8')); } catch (e) { return false; }
    }).map((p) => { try { return fs.readFileSync('/proc/' + p + '/comm', 'utf8').trim(); } catch (e) { return p; } });
}

async function main() {
    console.log('vizualyse-steam in the unit\'s root filesystem, GPU ' + GPU);
    startServer();
    for (let i = 0; i < 100 && !TOKEN; i++) {
        try { TOKEN = fs.readFileSync(ROOT + '/state/token', 'utf8').trim(); } catch (e) { await sleep(100); }
    }
    const t0 = Date.now();
    let s = await until('the bundles', (x) => x.bundle === 'ready' || x.bundle === 'failed', 20 * 60000);
    ok('the bundles unpack', s.bundle === 'ready', ((Date.now() - t0) / 1000).toFixed(0) + ' s' + (s.error ? ', ' + s.error : ''));
    const pfx = fs.statSync(ROOT + '/prefix/pfx');
    ok('the prefix is the tool uid\'s', pfx.uid === UID, 'uid ' + pfx.uid);
    ok('the prefix links into Proton', fs.readlinkSync(ROOT + '/prefix/pfx/drive_c/windows/system32/explorer.exe').indexOf(ROOT + '/proton/') === 0);
    let dns = '';
    try { dns = fs.readFileSync('/dev/shm/vzs.dns', 'utf8'); } catch (e) { /* none */ }
    ok('the phone\'s DNS is in the runtime\'s resolver file', /nameserver 192\.0\.2\.53/.test(dns));

    /* the real DepotDownloader on the runtime's .NET, as the tool's uid */
    const env = require(T + '/src/env.js');
    const dd = await new Promise((resolve) => {
        let out = '';
        const p = spawn(ROOT + '/runtime/dotnet/dotnet', [ROOT + '/runtime/depotdownloader/DepotDownloader.dll'],
            { env: env.dotnetEnv(), cwd: ROOT + '/home', uid: UID, gid: UID });
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('exit', (code) => resolve({ code: code, out: out }));
        p.on('error', (e) => resolve({ code: -1, out: e.message }));
    });
    ok('the real DepotDownloader starts on the runtime\'s .NET (uid 12996)', /DepotDownloader|depotdownloader -app/i.test(dd.out), 'exit ' + dd.code + ', ' + dd.out.split('\n')[0].slice(0, 80));

    /* a download through the stand-in */
    let r = await api('/api/install', { appId: APP });
    ok('install without an account is refused', r.code === 400 && /sign in/.test(r.body.error));
    r = await api('/api/user', { username: 'tester' });
    ok('the account is kept', r.code === 200 && r.body.account.username === 'tester');
    r = await api('/api/install', { appId: APP });
    ok('install starts', r.code === 200, r.body && r.body.error);
    s = await until('the password question', (x) => x.download && (x.download.state === 'password' || x.download.state === 'failed'), 30000);
    ok('Steam asks for the password', s.download.state === 'password');
    await api('/api/answer', { text: 'hunter2' });
    s = await until('the Steam Guard question', (x) => x.download && (x.download.state === 'code' || x.download.state === 'failed'), 30000);
    ok('then for a Steam Guard code', s.download.state === 'code' && s.download.kind === 'app');
    await api('/api/answer', { text: '99999' });
    s = await until('the wrong code', (x) => x.download && x.download.wrongCode, 30000);
    ok('a wrong code is said', s.download.state === 'code');
    await api('/api/answer', { text: '12345' });
    s = await until('the download', (x) => x.download && (x.download.state === 'done' || x.download.state === 'failed'), 60000);
    ok('the download ends', s.download.state === 'done', s.download.note);
    ok('no password in the tool\'s log', serverLog.indexOf('hunter2') < 0);
    const g = s.library.filter((x) => x.appId === APP)[0];
    ok('the game is in the library with its program', g && g.exe === 'TestGame.exe', g && g.exe);
    ok('the login is remembered', s.account.remembered === true);
    let files = [];
    try { files = fs.readdirSync(ROOT + '/games/' + APP); } catch (e) { /* none */ }
    ok('the game\'s files are the tool uid\'s', files.length && fs.statSync(ROOT + '/games/' + APP + '/TestGame.exe').uid === UID);

    /* the iDrive app's socket */
    const first = await new Promise((resolve) => {
        const c = net.createConnection('/tmp/ctl/ctl.sock');
        let b = '';
        c.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { c.destroy(); resolve(b.slice(0, i)); } });
        c.on('error', (e) => resolve('error ' + e.message));
        setTimeout(() => { c.destroy(); resolve(b); }, 3000);
    });
    let st = null;
    try { st = JSON.parse(first); } catch (e) { /* no */ }
    ok('the app\'s socket sends the status', st && st.ev === 'status' && st.library.length === 1);

    /* playing it */
    r = await api('/api/play', { appId: APP });
    ok('play starts', r.code === 200, r.body && r.body.error);
    const tp = Date.now();
    s = await until('the game drawing', (x) => x.game && (x.game.state === 'running' || x.game.state === 'ended') && (x.game.pictures > 2 || x.game.state === 'ended'), 6 * 60000);
    ok('the game draws into wl-sink', s.game.state === 'running', ((Date.now() - tp) / 1000).toFixed(0) + ' s to the first pictures' + (s.game.note ? ', ' + s.game.note : ''));
    if (s.game.state === 'running') {
        await sleep(3000);
        s = await status();
        const b = s.game.buffers || {};
        if (GPU === 'stub') ok('its frames come as GPU (PRIME) buffers', s.game.gpuBuffers && b.drm > 0, JSON.stringify(b) + ', ' + s.game.fps + ' pictures/s');
        else ok('its frames come as shared memory on llvmpipe', b.shm > 0 || b.drm > 0, JSON.stringify(b) + ', ' + s.game.fps + ' pictures/s');
        /* the frame file: the newest slot */
        const f = fs.readFileSync('/dev/shm/mgu-video-vizualyse_steam');
        const w = f.readUInt32LE(8), h = f.readUInt32LE(12), slot = f.readUInt32LE(20);
        const y = f.slice(64 + slot * w * h * 3 / 2, 64 + slot * w * h * 3 / 2 + w * h);
        let max = 0;
        for (let i = 0; i < y.length; i += 97) max = Math.max(max, y[i]);
        if (GPU === 'swrast') ok('the frame file has the game\'s picture', max > 40, w + 'x' + h + ', brightest Y ' + max);
        else ok('the frame file is there at the picture\'s size', w === 1280 && h === 720, w + 'x' + h);
        r = await api('/api/show', {});
        ok('show without mgu-render says so', r.code === 400 && /mgu-render/.test(r.body.error), r.body && r.body.error);
        let mkdirRunning = null;
        try { mkdirRunning = JSON.parse(fs.readFileSync(ROOT + '/state/game-running', 'utf8')); } catch (e) { /* none */ }
        ok('a running game is marked', mkdirRunning && mkdirRunning.appId === APP);
        let tl = '';
        try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        const adapter = /adapter "([^"]*)".*device 0x([0-9a-f]+)/.exec(tl);
        ok('Direct3D reports the adapter set in the prefix (HD Graphics 510, 0x1902)', adapter && adapter[2] === '1902',
            adapter ? adapter[1] + ', 0x' + adapter[2] : 'no adapter line: ' + tl.slice(0, 120));
    }
    r = await api('/api/stop', {});
    s = await until('the game ending', (x) => x.game && x.game.state === 'ended', 60000);
    await sleep(2500);
    const left = uidProcesses(UID);
    ok('stop ends every process of the uid', left.length === 0, left.join(' '));
    ok('the frame file goes', !fs.existsSync('/dev/shm/mgu-video-vizualyse_steam'));
    ok('the running mark goes', !fs.existsSync(ROOT + '/state/game-running'));

    server.kill('SIGTERM');
    await new Promise((resolve) => { server.on('exit', resolve); setTimeout(resolve, 15000); });
    const wineErr = serverLog.split('\n').filter((l) => /wine: .*err:/.test(l)).map((l) => l.replace(/^.*?err:/, 'err:').replace(/^err:([^:]+:[^ ]+).*/, 'err:$1'));
    const counts = {};
    wineErr.forEach((l) => { counts[l] = (counts[l] || 0) + 1; });
    console.log('  Wine\'s errors: ' + (Object.keys(counts).map((k) => counts[k] + 'x ' + k).join(', ') || 'none'));
    if (failed || process.env.VERBOSE) {
        console.log('---- the tool\'s log (last 80 lines) ----');
        console.log(serverLog.split('\n').slice(-80).join('\n'));
    }
    /* GREP_LOG=regex: those lines of the tool's log */
    if (process.env.GREP_LOG) console.log(serverLog.split('\n').filter((l) => new RegExp(process.env.GREP_LOG).test(l)).join('\n'));
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.log('  FAIL ' + e.message);
    console.log('---- the tool\'s log (last 80 lines) ----');
    console.log(serverLog.split('\n').slice(-80).join('\n'));
    if (server) server.kill('SIGKILL');
    process.exit(1);
});
