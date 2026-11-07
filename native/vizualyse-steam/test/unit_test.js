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

/* A tap at screen pixel sx, sy for steam-touch --touch-file (the display's
 * touch PDU as vizualyse-chromium's test makes it: down, then up 40 ms later);
 * readable by nobody, which steam-touch drops to. */
function touchFile(sx, sy) {
    const pdu = (ev) => {
        const b = Buffer.alloc(112);
        b.writeUInt32BE(0xB0048002, 0); b.writeUInt32BE(96, 4);
        b[28] = 0x80; b[53] = 1; b.writeUInt16BE(sx, 54); b.writeUInt16BE(sy, 60); b[62] = 50; b[63] = ev << 4;
        return b.toString('hex');
    };
    fs.writeFileSync('/dev/shm/touch.txt.tmp', ['300 160.48.199.115 112 ' + pdu(1), '340 160.48.199.115 112 ' + pdu(3)].join('\n') + '\n');
    fs.chmodSync('/dev/shm/touch.txt.tmp', 0o644);
    fs.renameSync('/dev/shm/touch.txt.tmp', '/dev/shm/touch.txt');
}
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
/* with T_GAME: t_load's list (T_LOAD), and T_DLLOV in place of the tool's
 * WINEDLLOVERRIDES (to see a failure the tool's own overrides caused) */
if (process.env.T_LOAD) extra.T_LOAD = process.env.T_LOAD;
if (process.env.T_DLLOV) extra.WINEDLLOVERRIDES = process.env.T_DLLOV;
const senv = Object.assign({}, process.env, {
    STEAM_NO_FIREWALL: '1', STEAM_LEASE: '/tmp/lease.json', STEAM_CTL_SOCKET: '/tmp/ctl/ctl.sock',
    STEAM_RUNTIME_ARCHIVE: T + '/build/runtime.tgz', STEAM_PROTON_ARCHIVE: T + '/build/proton.tgz',
    STEAM_PREFIX_ARCHIVE: T + '/build/prefix.tgz', STEAM_LAUNCH: T + '/build/launch.json',
    STEAM_DD_CMD: '/usr/bin/node ' + T + '/test/fake_dd.js ' + T + '/build/win/' + (process.env.T_GAME || 't_d3d964.exe'),
    /* mgu-render's client: a stand-in (show works); the display's touches: a
     * replayed capture (touchFile) for steam-touch */
    STEAM_RENDER_CLIENT: T + '/test/fake_render_client.js', STEAM_TEST_RENDER_LOG: '/tmp/render.log',
    STEAM_TOUCH_FILE: '/dev/shm/touch.txt', STEAM_LINK_IP: '127.0.0.1',
    /* the test stick's device: the tmpfs's name, or the vfat image's loop device */
    STEAM_USB_TEST_DEV: (fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')
        .filter((l) => l.split(' ')[1] === '/media/TESTSTICK')[0] || 'teststick').split(' ')[0],
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

    /* the real DepotDownloader on the runtime's .NET, as the tool's uid,
     * started as the tool starts it, before any game (as after a start of the
     * unit: /dev/shm empty): it gets past its account store (IsolatedStorage,
     * a named mutex in XDG_RUNTIME_DIR: it aborted there on the car,
     * 2026-11-07) and asks for the password; no network here */
    const { Download } = require(T + '/src/steam.js');
    ok('no run-time folder yet (a fresh start of the unit)', !fs.existsSync('/dev/shm/vizualyse-steam/xdg'));
    const ddLog = [];
    const real = new Download({ appId: APP, username: 'tester', dir: ROOT + '/games/real-dd', uid: UID, gid: UID,
        log: (l) => ddLog.push(l) });
    const dd = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(real.status()), 60000);
        real.on('change', (x) => { if (x.state !== 'starting') { clearTimeout(timer); resolve(x); } });
        real.start();
    });
    real.stop();
    ok('the real DepotDownloader starts on the runtime\'s .NET (uid 12996) and asks for the password', dd.state === 'password',
        dd.state + (dd.note ? ', ' + dd.note : '') + ' | ' + ddLog.slice(-3).join(' | ').slice(0, 300));

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

    /* Run without Steam: gbe_fork's steam_api DLLs in place of the game's
     * (fake_dd.js puts stand-ins beside it), and back */
    {
        const gd = ROOT + '/games/' + APP, gbe = ROOT + '/runtime/goldberg/x64/steam_api64.dll';
        const same = (a, b) => { try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch (e) { return false; } };
        let s2 = await status();
        const g0 = s2.library.filter((x) => x.appId === APP)[0];
        ok('a game with Steam\'s API offers Run without Steam', g0 && g0.steamApi === 2 && g0.noSteam === false, g0 && JSON.stringify({ steamApi: g0.steamApi, noSteam: g0.noSteam }));
        r = await api('/api/game', { appId: APP, noSteam: true });
        ok('Run without Steam: on', r.code === 200, r.body && r.body.error);
        ok('gbe_fork\'s steam_api64.dll in place, Steam\'s kept beside it',
            same(gd + '/steam_api64.dll', gbe) && /stand-in/.test(fs.readFileSync(gd + '/steam_api64.dll.vzs-orig', 'utf8')));
        let appid = '';
        try { appid = fs.readFileSync(gd + '/steam_settings/steam_appid.txt', 'utf8').trim(); } catch (e) { /* none */ }
        ok('its settings: the app id, no networking', appid === String(APP) && /disable_networking=1/.test(fs.readFileSync(gd + '/steam_settings/configs.main.ini', 'utf8')), appid);
        if (!process.env.T_NOSTEAM) {
            r = await api('/api/game', { appId: APP, noSteam: false });
            ok('Run without Steam: off puts Steam\'s back, our settings gone',
                r.code === 200 && /stand-in/.test(fs.readFileSync(gd + '/steam_api64.dll', 'utf8')) && !fs.existsSync(gd + '/steam_api64.dll.vzs-orig') && !fs.existsSync(gd + '/steam_settings'),
                r.body && r.body.error);
        }
    }

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
        /* a tap where the picture's middle is on the screen (mgu-render fits
         * 1280x720 into the app area 1790x638+108+82, aspect kept): t_d3d9's
         * window (640x360 with a title bar) shows only its client area, centred,
         * so the click lands in the middle of the client area */
        const sc = Math.min(1790 / 1280, 638 / 720);
        touchFile(Math.round(108 + (1790 - 1280 * sc) / 2 + 640 * sc), Math.round(82 + (638 - 720 * sc) / 2 + 360 * sc));
        r = await api('/api/show', {});
        ok('show (a stand-in for mgu-render)', r.code === 200, r.body && r.body.error);
        let clicks = '';
        for (let i = 0; i < 40 && !/t_d3d9: click/.test(clicks); i++) {
            await sleep(250);
            try { clicks = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        }
        ok('touch reads the display (steam-touch)', /touch: ready \(reading\)/.test(serverLog));
        const cl = /t_d3d9: client (\d+) (\d+)/.exec(clicks), ck = /t_d3d9: click (-?\d+) (-?\d+)/.exec(clicks);
        ok('a tap on the picture is a click there: only the client area is shown (no title bar), the touch mapped into it',
            cl && ck && Math.abs(Number(ck[1]) - cl[1] / 2) <= 2 && Math.abs(Number(ck[2]) - cl[2] / 2) <= 2,
            (ck ? 'click ' + ck[1] + ',' + ck[2] : 'no click') + (cl ? ', client ' + cl[1] + 'x' + cl[2] : ''));
        await api('/api/hide', {});
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

    /* mscoree is on for games: a prefix update would offer Wine Mono's
     * installer in a window nobody can press */
    ok('no Wine Mono installer window (no prefix update)', !/window "Wine Mono Installer"/.test(serverLog));

    await controller();
    await usbStick();

    server.kill('SIGTERM');
    await new Promise((resolve) => { server.on('exit', resolve); setTimeout(resolve, 15000); });
    const wineErr = serverLog.split('\n').filter((l) => /wine: .*err:/.test(l)).map((l) => l.replace(/^.*?err:/, 'err:').replace(/^err:([^:]+:[^ ]+).*/, 'err:$1'));
    const counts = {};
    wineErr.forEach((l) => { counts[l] = (counts[l] || 0) + 1; });
    console.log('  Wine\'s errors: ' + (Object.keys(counts).map((k) => counts[k] + 'x ' + k).join(', ') || 'none'));
    if (process.env.T_GAME) {
        let tl = '';
        try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        console.log('---- ' + process.env.T_GAME + '\'s own lines ----\n' + tl);
    }
    if (failed || process.env.VERBOSE) {
        console.log('---- the tool\'s log (last 80 lines) ----');
        console.log(serverLog.split('\n').slice(-80).join('\n'));
    }
    /* GREP_LOG=regex: those lines of the tool's log */
    if (process.env.GREP_LOG) console.log(serverLog.split('\n').filter((l) => new RegExp(process.env.GREP_LOG).test(l)).join('\n'));
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

/* A controller: a virtual XInput USB pad (test/usbip_pad.c through the
 * Docker host's vhci_hcd: STEAM_TEST_USBPAD, run_unit_test.sh) that presses
 * A and pushes the left stick once a second; the game is t_xinput (app 4545,
 * fake_dd.js), which reads the four slots through XInputGetState for 8 s.
 * steam-pads claims the pad, our xinput1_4.dll reads its state in Wine. */
async function controller() {
    const bin = process.env.STEAM_TEST_USBPAD;
    if (!bin) { console.log('  --   the controller check skipped (no vhci_hcd in the Docker host\'s kernel)'); return; }
    const pad = spawn(bin, ['60'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let padOut = '';
    pad.stdout.on('data', (d) => { padOut += d; });
    pad.stderr.on('data', (d) => { padOut += d; });
    for (let i = 0; i < 40 && !/ready \/dev\/bus\/usb/.test(padOut); i++) await sleep(250);
    ok('a virtual XInput USB pad (usbip_pad, vhci_hcd)', /ready \/dev\/bus\/usb/.test(padOut), padOut.trim().split('\n')[0]);
    let r = await api('/api/install', { appId: 4545 });
    ok('the controller test game installs', r.code === 200, r.body && r.body.error);
    let s = await until('its download', (x) => x.download && x.download.appId === 4545 && ['done', 'failed', 'stopped'].indexOf(x.download.state) >= 0, 60000);
    let before = 0;
    try { before = fs.statSync(T_LOG).size; } catch (e) { /* none */ }
    r = await api('/api/play', { appId: 4545 });
    ok('play t_xinput', r.code === 200, r.body && r.body.error);
    s = await until('t_xinput ending', (x) => x.game && x.game.appId === 4545 && x.game.state === 'ended', 4 * 60000);
    let tl = '';
    try { tl = fs.readFileSync(T_LOG, 'utf8').slice(before); } catch (e) { /* none */ }
    ok('steam-pads claims the pad as player 1', /pads: player 1: /.test(serverLog));
    ok('a game reads the pad through our XInput: A and the left stick (XInputGetState)', /t_xinput: ok A lx/.test(tl),
        tl.split('\n').filter((l) => /t_xinput/.test(l)).slice(0, 6).join(' | ').slice(0, 300));
    ok('the pad is released with the game (steam-pads ends)', /pads: .*unplugged|pads: exited \(0\)/.test(serverLog) || !/steam-pads/.test(uidProcesses(0).join(' ')));
    try { pad.stdin.end(); } catch (e) { /* gone */ }
    await sleep(1000);
}

/* A USB stick as the install location. run_unit_test.sh mounts a tmpfs at
 * /media/TESTSTICK as the HMI mounts a stick: read-only, noexec, nosuid,
 * nodev, every file 0777 (FAT32 with fmask=0000); STEAM_USB_TEST_DEV names
 * it removable. */
async function usbStick() {
    const STICK = '/media/TESTSTICK', USBAPP = 4343, VIEW = ROOT + '/usb/TESTSTICK';
    const mount = (dir) => (fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').filter((l) => l.split(' ')[1] === dir)[0] || '').split(' ');
    if (!mount(STICK)[0]) { ok('the test stick is mounted (run_unit_test.sh)', false); return; }
    let s = await until('the stick offered', (x) => x.choices.usb.some((u) => u.id === 'TESTSTICK'), 15000);
    ok('a USB stick is offered as an install location', true, JSON.stringify(s.choices.usb));
    let r = await api('/api/settings', { where: 'usb:TESTSTICK' });
    ok('it can be the install location', r.code === 200, r.body && r.body.error);
    r = await api('/api/install', { appId: USBAPP });
    ok('an install onto the stick starts', r.code === 200, r.body && r.body.error);
    s = await until('the download onto the stick', (x) => x.download && x.download.appId === USBAPP && ['done', 'failed', 'stopped'].indexOf(x.download.state) >= 0, 60000);
    ok('the download onto the stick ends', s.download.state === 'done', s.download.note);
    const ug = s.library.filter((x) => x.appId === USBAPP)[0];
    ok('the game is on the stick', ug && ug.usb === 'TESTSTICK' && ug.present && fs.existsSync(STICK + '/vizualyse-steam/games/' + USBAPP + '/TestGame.exe'),
        ug && JSON.stringify(ug));
    const hmi = (mount(STICK)[3] || '').split(','), ours = (mount(VIEW)[3] || '').split(',');
    ok('the HMI\'s mount is read-write now, its noexec / nosuid / nodev kept', hmi.indexOf('rw') >= 0 && hmi.indexOf('noexec') >= 0 && hmi.indexOf('nosuid') >= 0 && hmi.indexOf('nodev') >= 0, hmi.join(','));
    ok('our view of it runs programs (no noexec), nosuid, nodev', ours.length > 1 && ours.indexOf('noexec') < 0 && ours.indexOf('nosuid') >= 0, ours.join(','));
    r = await api('/api/play', { appId: USBAPP });
    ok('play from the stick starts', r.code === 200, r.body && r.body.error);
    s = await until('the stick\'s game drawing', (x) => x.game && x.game.appId === USBAPP && (x.game.state === 'ended' || x.game.pictures > 2), 6 * 60000);
    ok('a game on the stick runs and draws', s.game.state === 'running', s.game.note);
    /* the stick's game is the 32-bit test program (fake_dd.js): new WoW64
     * through patches/wine-no-ia32.patch (no int $0x80, an LDT %fs per thread) */
    if (!process.env.T_GAME) {
        let tl = '';
        try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        ok('the 32-bit program draws through Direct3D 9 (WoW64, LDT %fs)', /t_d3d9: 32-bit/.test(tl) && /t_d3d9: device/.test(tl.slice(tl.lastIndexOf('t_d3d9: 32-bit'))),
            tl.split('\n').filter((l) => /32-bit|device|FAIL/.test(l)).join(' | ').slice(0, 200));
    }
    await api('/api/stop', {});
    await until('the stick\'s game ending', (x) => x.game && x.game.state === 'ended', 60000);
    await sleep(1500);
    /* pulled: udisks unmounts the HMI's mount */
    require('child_process').execFileSync('umount', [STICK]);
    s = await until('the stick gone', (x) => x.library.some((g) => g.appId === USBAPP && g.present === false), 15000);
    ok('a pulled stick: its game is shown as away', true);
    for (let i = 0; i < 20 && mount(VIEW)[0]; i++) await sleep(500);   /* swept every 3 s */
    ok('our view of a pulled stick goes', !mount(VIEW)[0]);
    r = await api('/api/play', { appId: USBAPP });
    ok('and it can\'t be played', r.code === 400 && /plug it in/.test(r.body.error), r.body && r.body.error);
    r = await api('/api/install', { appId: 4444 });
    ok('nor installed onto', r.code === 400 && /not plugged in/.test(r.body.error), r.body && r.body.error);
}

main().catch((e) => {
    console.log('  FAIL ' + e.message);
    console.log('---- the tool\'s log (last 80 lines) ----');
    console.log(serverLog.split('\n').slice(-80).join('\n'));
    if (server) server.kill('SIGKILL');
    process.exit(1);
});
