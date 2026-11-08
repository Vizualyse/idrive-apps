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
/* the tools' bus: native/vizualyse-bus's broker when run_unit_test.sh found it built (MOSQUITTO) */
const BUS_SOCKET = '/run/vizualyse-bus-test/mqtt.sock';
let broker = null, browserBus = null;
const senv = Object.assign({}, process.env, {
    VZ_BUS_SOCKET: BUS_SOCKET,
    STEAM_NO_FIREWALL: '1', STEAM_LEASE: '/tmp/lease.json', STEAM_CTL_SOCKET: '/tmp/ctl/ctl.sock',
    STEAM_RUNTIME_ARCHIVE: T + '/build/runtime.tgz', STEAM_PROTON_ARCHIVE: T + '/build/proton.tgz',
    STEAM_PREFIX_ARCHIVE: T + '/build/prefix.tgz', STEAM_VULKAN_ARCHIVE: T + '/build/vulkan.tgz', STEAM_LAUNCH: T + '/build/launch.json',
    STEAM_DD_CMD: '/usr/bin/node ' + T + '/test/fake_dd.js ' + T + '/build/win/' + (process.env.T_GAME || 't_d3d964.exe'),
    /* mgu-render's client: a stand-in (show works); the display's touches: a
     * replayed capture (touchFile) for steam-touch */
    STEAM_RENDER_CLIENT: T + '/test/fake_render_client.js', STEAM_TEST_RENDER_LOG: '/tmp/render.log',
    STEAM_TOUCH_FILE: '/dev/shm/touch.txt', STEAM_LINK_IP: '127.0.0.1', STEAM_SINK_DEBUG: process.env.WINSTON_CHECK ? '1' : '',
    /* the test stick's device: the tmpfs's name, or the vfat image's loop device */
    STEAM_USB_TEST_DEV: (fs.readFileSync('/proc/self/mounts', 'utf8').split('\n')
        .filter((l) => l.split(' ')[1] === '/media/TESTSTICK')[0] || 'teststick').split(' ')[0],
});
/* Vulkan (env.VK, the bundled vulkan.tgz): checked on the stub only, with
 * kernel414 (the unit's kernel's answers, tools/vk-trial's build mounted at
 * /vkt by run_unit_test.sh) behind vk_crumbs.so, which the tool preloads
 * first itself for a Vulkan game */
const VK = fs.existsSync('/vkt/bench/kernel414.so') && GPU === 'stub';
if (VK) extra.LD_PRELOAD = '/vkt/bench/kernel414.so:' + extra.LD_PRELOAD;
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
    if (process.env.MOSQUITTO) {
        try { fs.mkdirSync(path.dirname(BUS_SOCKET), 0o700); } catch (e) { /* there */ }
        fs.writeFileSync('/tmp/mosquitto.conf', fs.readFileSync(process.env.MOSQUITTO_CONF, 'utf8').replace(/^listener 0 .*$/m, 'listener 0 ' + BUS_SOCKET));
        broker = spawn(process.env.MOSQUITTO, ['-c', '/tmp/mosquitto.conf'], { stdio: 'ignore' });
        for (let i = 0; i < 50 && !fs.existsSync(BUS_SOCKET); i++) await sleep(100);
        const { Bus } = require(T + '/src/mqtt_bus.js');
        /* a stand-in for the Browser in game mode */
        browserBus = new Bus('vizualyse-chromium', { socket: BUS_SOCKET });
    }
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

    /* Vulkan is the default for a 64-bit game (the bundled ANV and DXVK);
     * these checks are of WineD3D on OpenGL, so it goes off for them */
    {
        const s2 = await status();
        const g0 = s2.library.filter((x) => x.appId === APP)[0];
        ok('Vulkan is the default for the 64-bit test game', s2.vulkanAvailable === true && g0 && g0.arch === 'x64' && g0.vulkanDefault === true && g0.vulkan === true,
            g0 && JSON.stringify({ available: s2.vulkanAvailable, arch: g0.arch, vulkan: g0.vulkan, vulkanDefault: g0.vulkanDefault }));
        r = await api('/api/game', { appId: APP, vulkan: false });
        ok('Vulkan: off for the game (WineD3D)', r.code === 200, r.body && r.body.error);
    }

    /* the Browser in game mode asks steam off before the game starts: a game
     * started after it still runs (the newer start wins) */
    if (browserBus) {
        browserBus.ask({ steam: 'off' }, 'the Browser is in game mode');
        s = await until('the browser\'s ask', (x) => x.bus && x.bus.connected && x.bus.others.some((o) => o.from === 'vizualyse-chromium'), 15000);
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
        /* t_d3d9 asks for no vsync (D3DPRESENT_INTERVAL_IMMEDIATE), Proton's
         * Wine for swap interval 0: vblank_mode 3 holds each swap to wl-sink's
         * frame callbacks, at the tool's 30 a second. The i965 driver has that
         * option; llvmpipe hasn't (unthrottled there: shown, not checked) */
        {
            const rate = await commitRate();
            if (GPU === 'stub') ok('WineD3D draws at the tool\'s frame rate, not as fast as it can (vblank_mode 3)', rate > 5 && rate <= 36, rate.toFixed(1) + ' frames/s');
            else console.log('  --   llvmpipe: ' + rate.toFixed(1) + ' frames/s (no vblank_mode option in swrast)');
        }
        /* the frame file: the newest slot */
        const f = fs.readFileSync('/dev/shm/mgu-video-vizualyse_steam');
        const w = f.readUInt32LE(8), h = f.readUInt32LE(12), slot = f.readUInt32LE(20);
        const y = f.slice(64 + slot * w * h * 3 / 2, 64 + slot * w * h * 3 / 2 + w * h);
        let max = 0;
        for (let i = 0; i < y.length; i += 97) max = Math.max(max, y[i]);
        if (GPU === 'swrast') ok('the frame file has the game\'s picture', max > 40, w + 'x' + h + ', brightest Y ' + max);
        else ok('the frame file is there at the picture\'s size (960x540, the default)', w === 960 && h === 540, w + 'x' + h);
        /* the bus (none here: the ask waits for it, native/vizualyse-bus/test has the rest) */
        ok('while a game runs, the other tools are asked for their cluster and HUD video and the browser off', s.bus && s.bus.mine &&
            s.bus.mine['cluster-video'] === 'off' && s.bus.mine['hud-video'] === 'off' && s.bus.mine.browser === 'off', JSON.stringify(s.bus));
        if (browserBus) ok('an ask for steam off made before the game started does not stop it', s.game.state === 'running' && !s.busNote, s.game.state);
        /* a tap where the picture's middle is on the screen (mgu-render fits
         * the picture into the app area 1790x638+108+82, aspect kept): t_d3d9's
         * window (640x360 with a title bar) shows only its client area, centred,
         * so the click lands in the middle of the client area */
        const sc = Math.min(1790 / w, 638 / h);
        touchFile(Math.round(108 + (1790 - w * sc) / 2 + w / 2 * sc), Math.round(82 + (638 - h * sc) / 2 + h / 2 * sc));
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
        if (process.env.WINSTON_CHECK) await winston();
        let mkdirRunning = null;
        try { mkdirRunning = JSON.parse(fs.readFileSync(ROOT + '/state/game-running', 'utf8')); } catch (e) { /* none */ }
        ok('a running game is marked', mkdirRunning && mkdirRunning.appId === APP);
        let tl = '';
        try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        const adapter = /adapter "([^"]*)".*device 0x([0-9a-f]+)/.exec(tl);
        ok('Direct3D reports the adapter set in the prefix (HD Graphics 510, 0x1902)', adapter && adapter[2] === '1902',
            adapter ? adapter[1] + ', 0x' + adapter[2] : 'no adapter line: ' + tl.slice(0, 120));
    }
    if (browserBus) {
        /* game mode turned on again (a new ask) while the game runs: it stops */
        browserBus.ask(null);
        await sleep(500);
        browserBus.ask({ steam: 'off' }, 'the Browser is in game mode');
    } else {
        r = await api('/api/stop', {});
    }
    s = await until('the game ending', (x) => x.game && x.game.state === 'ended', 60000);
    if (browserBus) {
        ok('an ask for steam off made while the game runs stops it, and says who asked', /^stopped: vizualyse-chromium asked \(the Browser is in game mode\)$/.test(s.busNote || ''), s.busNote);
        browserBus.ask(null);
    }
    await sleep(2500);
    const left = uidProcesses(UID);
    ok('stop ends every process of the uid', left.length === 0, left.join(' '));
    ok('the frame file goes', !fs.existsSync('/dev/shm/mgu-video-vizualyse_steam'));
    ok('the running mark goes', !fs.existsSync(ROOT + '/state/game-running'));
    s = await status();
    ok('the game ended: nothing asked of the other tools', s.bus && s.bus.mine === null, JSON.stringify(s.bus));
    if (process.env.WINSTON_CHECK && GPU === 'stub') await scaledMode();
    if (GPU === 'stub') await detailMode();

    /* mscoree is on for games: a prefix update would offer Wine Mono's
     * installer in a window nobody can press */
    ok('no Wine Mono installer window (no prefix update)', !/window "Wine Mono Installer"/.test(serverLog));

    await controller();
    await usbStick();
    await vulkan();

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

/* Vulkan, per game: the test game (t_d3d9, 64-bit) on DXVK 1.9.4 and ANV
 * from the bundled vulkan.tgz, its ICD only while it runs, its DRM calls in
 * state/vulkan-crumbs.log; then a restart of the unit during it (the marker
 * left, the tool started again) turns its Vulkan off. */
async function vulkan() {
    if (!VK) { console.log('  (Vulkan: kernel414 (tools/vk-trial\'s build) not mounted, or not the stub: skipped)'); return; }
    const ICD = '/dev/shm/vizualyse-steam/vk_icd.json', CRUMBS = ROOT + '/state/vulkan-crumbs.log';
    let s = await status();
    ok('Vulkan is offered (vulkan.tgz unpacked)', s.vulkanAvailable === true);
    let r = await api('/api/game', { appId: APP, vulkan: true });
    ok('Vulkan: on for the game', r.code === 200, r.body && r.body.error);
    ok('no ICD while no game runs', !fs.existsSync(ICD));
    try { fs.writeFileSync(T_LOG, ''); } catch (e) { /* new */ }
    r = await api('/api/play', { appId: APP });
    ok('play on Vulkan starts', r.code === 200, r.body && r.body.error);
    ok('ANV\'s ICD in the run folder while it runs', fs.existsSync(ICD));
    let mark = {};
    try { mark = JSON.parse(fs.readFileSync(ROOT + '/state/game-running', 'utf8')); } catch (e) { /* none */ }
    ok('the running marker says Vulkan', mark.vulkan === true);
    s = await until('the game drawing on Vulkan', (x) => x.game && x.game.appId === APP && (x.game.state === 'ended' || x.game.pictures > 2), 6 * 60000);
    ok('the game draws on Vulkan', s.game.state === 'running', s.game.note);
    await sleep(3000);
    let tl = '';
    try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
    /* DXVK's on ANV, reporting the adapter WineD3D does (env.dxvkConf), not the HD 505 */
    ok('its Direct3D 9 is DXVK\'s, reporting HD Graphics 510 (8086:1902) as WineD3D does',
        /t_d3d9: adapter "Intel\(R\) HD Graphics 510" driver "igdumd64\.dll" vendor 0x8086 device 0x1902/.test(tl),
        tl.split(/\r?\n/).filter((l) => /adapter|FAIL/.test(l)).join(' | ').slice(0, 200));
    let conf = '';
    try { conf = fs.readFileSync('/dev/shm/vizualyse-steam/dxvk.conf', 'utf8'); } catch (e) { /* none */ }
    ok('DXVK\'s options in the run folder while it runs, at the tool\'s frame rate', /^d3d9\.maxFrameRate = 30$/m.test(conf) && /^dxvk\.numCompilerThreads = 2$/m.test(conf),
        conf.split('\n').length + ' lines');
    s = await status();
    const b = (s.game && s.game.buffers) || {};
    ok('its frames reach wl-sink as GPU buffers', b.drm > 0 || b.fwd > 0, JSON.stringify(b));
    const rate = await commitRate();
    /* at most: on the stub DXVK runs below 30 anyway (17-18 a second, with or
     * without the cap: the crumbs log's synchronous writes, 2026-11-08) */
    ok('DXVK draws at most at the tool\'s frame rate (d3d9.maxFrameRate)', rate > 5 && rate <= 36, rate.toFixed(1) + ' frames/s');
    let crumbs = '';
    try { crumbs = fs.readFileSync(CRUMBS, 'utf8'); } catch (e) { /* none */ }
    ok('its DRM calls in state/vulkan-crumbs.log', /> GEM_EXECBUFFER2/.test(crumbs), crumbs.split('\n').length + ' lines');
    await api('/api/stop', {});
    await until('the Vulkan game ending', (x) => x.game && x.game.state === 'ended', 60000);
    ok('the ICD gone after it', !fs.existsSync(ICD));
    ok('DXVK\'s options gone after it', !fs.existsSync('/dev/shm/vizualyse-steam/dxvk.conf'));
    /* the unit restarts during a Vulkan game: the marker stays, the tool starts again */
    server.kill('SIGTERM');
    await new Promise((resolve) => { server.on('exit', resolve); setTimeout(resolve, 15000); });
    fs.writeFileSync(ROOT + '/state/game-running', JSON.stringify({ appId: APP, name: 'TestGame', at: new Date().toISOString(), vulkan: true }));
    startServer();
    s = await until('the tool again', (x) => x.bundle === 'ready' || x.bundle === 'failed', 120000);
    const g = s.library.filter((x) => x.appId === APP)[0];
    ok('after a restart during it, Vulkan is off for the game', g && g.vulkan === false && /Vulkan is off/.test(s.restartNote || ''), s.restartNote);
}

/* The frames the game hands wl-sink a second (its commits), over 3 s. */
async function commitRate() {
    const c0 = ((await status()).game.buffers || {}).commits || 0, t0 = Date.now();
    await sleep(3000);
    const c1 = ((await status()).game.buffers || {}).commits || 0;
    return (c1 - c0) * 1000 / (Date.now() - t0);
}

/* A game at a display mode the screen doesn't have (t_d3d9 full screen at
 * 640x480 on wl-sink's 960x540): Wine emulates the mode and scales the
 * picture with a viewport, and wl-sink still passes its GPU buffers to
 * Winston as they are, Winston scaling them (wo_present_view). The stub. */
async function scaledMode() {
    fs.writeFileSync('/tmp/t_fullscreen', '640x480\n');
    try { fs.writeFileSync(T_LOG, ''); } catch (e) { /* new */ }
    let r = await api('/api/play', { appId: APP });
    ok('full screen at 640x480: play starts', r.code === 200, r.body && r.body.error);
    let s = await until('the full-screen game drawing', (x) => x.game && (x.game.state === 'ended' || x.game.pictures > 2), 6 * 60000);
    if (s.game.state === 'running') {
        await api('/api/winston', { on: true });
        await api('/api/show', {});
        await sleep(3000);
        const b0 = (await status()).game.buffers;
        await sleep(3000);
        s = await status();
        const b = s.game.buffers;
        let tl = '';
        try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
        const st = (f) => { try { const x = fs.statSync(f); return f + ' ' + x.uid + ' ' + (x.mode & 0o777).toString(8) + ' ' + x.size; } catch (e) { return f + ' missing'; } };
        ok('full screen at an emulated 640x480: Wine\'s buffers still go to Winston as they are, Winston scaling them',
            /full screen 640x480/.test(tl) && b.scaled - b0.scaled > 20 && b.drm === b0.drm,
            JSON.stringify(b) + ', ' + (tl.split(/\r?\n/).filter((l) => /full screen|FAIL/.test(l)).join(' | ') ||
                'no full-screen line; ' + st('/tmp/t_fullscreen') + '; ' + st(T_LOG) + '; its lines: ' + tl.split(/\r?\n/).slice(0, 6).join(' | ')));
        await api('/api/hide', {});
        await api('/api/winston', { on: false });
    } else ok('full screen at 640x480: the game draws', false, s.game.note);
    fs.unlinkSync('/tmp/t_fullscreen');
    await api('/api/stop', {});
    await until('the full-screen game ending', (x) => x.game && x.game.state === 'ended', 60000);
}

/* Detail Potato on WineD3D: WINE_D3D_CONFIG caps the shader model, which
 * the test program reads from its device (normal: "vs 3.0 ps 3.0" on the
 * stub's i965); the tool's log names what it applied. The stub. */
async function detailMode() {
    let r = await api('/api/game', { appId: APP, detail: 'potato', vulkan: false });
    ok('Detail potato is a game option', r.code === 200 && (await status()).library.filter((x) => x.appId === APP)[0].detail === 'potato', r.body && r.body.error);
    try { fs.writeFileSync(T_LOG, ''); } catch (e) { /* new */ }
    r = await api('/api/play', { appId: APP });
    const s = await until('the potato game drawing', (x) => x.game && (x.game.state === 'ended' || x.game.pictures > 2), 6 * 60000);
    let tl = '';
    try { tl = fs.readFileSync(T_LOG, 'utf8'); } catch (e) { /* none */ }
    /* the last caps line: the file can still hold an earlier game's (its truncation above doesn't always take) */
    const caps = (tl.match(/vs \d\.\d ps \d\.\d/g) || ['none']).pop();
    /* the game process's own environment (this test is root in the same container) */
    let genv = 'no game process found';
    fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).forEach((p) => {
        try {
            if (!/TestGame\.exe/.test(fs.readFileSync('/proc/' + p + '/cmdline', 'utf8'))) return;
            const v = fs.readFileSync('/proc/' + p + '/environ', 'utf8').split('\0').filter((x) => /^WINE_D3D_CONFIG=|^WINEDLLOVERRIDES=/.test(x));
            genv = 'pid ' + p + ': ' + (v.join(' ; ') || 'no WINE_D3D_CONFIG');
        } catch (e) { /* gone */ }
    });
    ok('Detail potato on WineD3D: shader model 2 (WINE_D3D_CONFIG), and the log says what was applied',
        s.game.state === 'running' && caps === 'vs 2.0 ps 2.0' && /detail: .* potato \(WineD3D: .*MaxShaderModelPS=2/.test(serverLog),
        caps + ', ' + (serverLog.split('\n').filter((l) => / detail: /.test(l)).pop() || 'no detail line') + '; ' + genv + '; ' +
        (serverLog.split('\n').filter((l) => / vulkan: App/.test(l)).pop() || '') + '; its lines: ' + tl.split(/\r?\n/).join(' | '));
    await api('/api/stop', {});
    await until('the potato game ending', (x) => x.game && x.game.state === 'ended', 60000);
    await api('/api/game', { appId: APP, detail: 'normal' });
}

/* Winston output (run_winston_test.sh: the unit's own Winston runs in this
 * container, tools/winston-bench): the running game's picture straight on
 * the centre screen through wl-sink's own connection, read back from what
 * Winston composed (kms_shim's grab), then hidden, then off. */
async function winston() {
    const grab = () => {
        const f = (process.env.KMS_SHIM_GRAB || '/out/grab') + '.ppm';
        try { fs.unlinkSync(f); } catch (e) { /* none */ }
        try { require('child_process').execFileSync('/bench/wo_bench', ['grab'], { stdio: 'ignore', timeout: 10000 }); } catch (e) { return null; }
        const b = fs.readFileSync(f);
        let off = 0, fields = [];
        while (fields.length < 4) { const e = b.indexOf(0x0a, off); fields = fields.concat(b.slice(off, e).toString().split(/\s+/).filter(Boolean)); off = e + 1; }
        const W = Number(fields[1]);
        return (x, y) => { const i = off + (y * W + x) * 3; return b[i] + b[i + 1] + b[i + 2]; };
    };
    /* the brightest of a grid of points in the app area, and left of it */
    const scan = (px) => {
        let inside = 0, outside = 0;
        for (let y = 90; y < 715; y += 13) for (let x = 0; x < 1920; x += 17) {
            const v = px(x, y);
            if (x >= 112 && x < 1894 && y >= 86) inside = Math.max(inside, v); else if (x < 100) outside = Math.max(outside, v);
        }
        return { inside, outside };
    };
    let s = await status();
    ok('wl-sink connected to Winston', s.winston && s.winston.connected === true, JSON.stringify(s.winston));
    let r = await api('/api/winston', { on: true });
    ok('Winston output on', r.code === 200 && s.running, r.body && r.body.error);
    r = await api('/api/show', {});
    await sleep(3000);
    s = await status();
    ok('shown through Winston', r.code === 200 && s.shown && s.winston.via === 'winston', JSON.stringify(s.winston));
    if (GPU === 'stub') {
        /* the unit's i965 (no pixels): Wine's GPU buffers go to Winston as they are */
        const b0 = s.game.buffers || {};
        await sleep(2000);
        s = await status();
        const b = s.game.buffers || {};
        ok('Wine\'s GPU buffers go to Winston as they are (no read-back)', b.fwd > 20 && b.drm === b0.drm,
            JSON.stringify(b) + ', ' + s.game.fps + ' pictures/s');
        /* Upscaling FSR, at once: each buffer drawn by FSR (the unit's i965
         * compiles and runs the passes, no pixels) into ours at its size on
         * the screen, shown by Winston; still no read-back. The test game's
         * client area is 632x326 of the 960x540 picture, which is fitted to
         * 1790x638 (x 638/540): 747x385. Then off: passed on as it is again. */
        const k = Math.min(1790 / 960, 638 / 540), want = [Math.round(632 * k), Math.round(326 * k)].join(',');
        if (!process.env.SKIP_FSR_CHECK) {
        r = await api('/api/settings', { upscale: 'fsr' });
        await sleep(3000);
        const f0 = (await status()).game;
        await sleep(2000);
        s = await status();
        const f1 = s.game;
        ok('Upscaling FSR: pictures drawn by FSR at the size on the screen, shown by Winston, no read-back',
            r.code === 200 && s.settings.upscale === 'fsr' && f1.fsr && f0.fsr && f1.fsr.pictures - f0.fsr.pictures > 20 &&
            String(f1.fsr.size) === want && f1.buffers.drm === f0.buffers.drm && f1.buffers.fwd === f0.buffers.fwd,
            JSON.stringify(f1.fsr) + ', ' + JSON.stringify(f1.buffers) + ', ' + f1.fps + ' pictures/s');
        await api('/api/settings', { upscale: 'off' });
        await sleep(2500);
        const g0 = (await status()).game;
        await sleep(2000);
        const g1 = (await status()).game;
        ok('Upscaling off: Wine\'s buffers to Winston as they are again', g1.buffers.fwd - g0.buffers.fwd > 20 && g1.fsr.pictures === g0.fsr.pictures,
            JSON.stringify(g1.buffers) + ', ' + JSON.stringify(g1.fsr));
        /* the journal's perf lines (src/perf.js): the change of mode, and FSR's window closed by it with fps and lows */
        const pl = serverLog.split('\n').filter((l) => / perf: /.test(l));
        ok('perf lines: each change of upscaling, and FSR\'s window with fps, 1% low and its GPU time',
            pl.some((l) => /upscaling off -> fsr/.test(l)) && pl.some((l) => /perf: fsr at 960x540: [\d.]+ fps, 1% low [\d.]+, .*FSR [\d.]+\/s at [\d.]+ ms GPU/.test(l)),
            pl.slice(-4).join(' | ') || 'no perf lines');
        }
        await api('/api/hide', {});
        await sleep(2500);   /* the stats line is a second's */
        const h0 = (await status()).game.buffers;
        await sleep(3000);
        const h1 = (await status()).game.buffers;
        ok('hidden: the game goes on, read back into the frame file again', h1.drm - h0.drm >= 30 && h1.fwd === h0.fwd,
            (h1.drm - h0.drm) + ' read back in 3 s, ' + JSON.stringify(h1));
    } else {
        let px = grab();
        let v = px ? scan(px) : null;
        ok('the game\'s picture is on Winston\'s centre screen, in the app area', !!v && v.inside > 120 && v.outside === 0, JSON.stringify(v));
        await api('/api/hide', {});
        await sleep(1000);
        px = grab();
        v = px ? scan(px) : null;
        ok('hidden: gone from the screen', !!v && v.inside === 0, JSON.stringify(v));
    }
    r = await api('/api/winston', { on: false });
    s = await status();
    ok('Winston output off', r.code === 200 && s.winston.on === false);
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
