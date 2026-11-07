// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// DXVK under Proton on the unit, through vk-trial's gate. Node 8 (the
// unit's). Uses the Steam tool's installed bundles (runtime, Proton,
// launch.json's environment and argv: Proton's own, captured at build time,
// as the tool's game.js starts Wine) and a private prefix of its own.
//
//   node run.js setup   as root, by hand, outside the gate: copies the Steam
//                       tool's prefix to prefix/ here, puts DXVK's DLLs in
//                       its system32 / syswow64, all owned by uid 12990.
//                       Nothing of the Steam tool changes.
//   node run.js run     the gate's child (uid 12990, group video, ANV through
//                       the gate's ICD in /run, crumbs preloaded): wl-sink
//                       (vk-trial's, offscreen: its frame file and snapshot
//                       in a private /tmp folder), then each test program
//                       through Wine with Direct3D on DXVK; checks their
//                       lines, wl-sink's GPU buffers, the picture.
//
//   vk-trial arm command --timeout 240 -- /usr/bin/node /var/opt/vk-trial/dxvk/run.js run
//
// Sound is off (winealsa.drv=d): the car's audio path is not touched. The
// Vulkan loader is vk-trial's lib/libvulkan.so.1 (the Steam runtime has none
// and must not: its bundle.sh refuses GPU drivers and ICDs).
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HERE = __dirname;                                   // /var/opt/vk-trial/dxvk
const VKT = path.dirname(HERE);                           // /var/opt/vk-trial
const STEAM = process.env.VKT_STEAM_ROOT || '/var/opt/vizualyse-steam';
const LAUNCH = process.env.VKT_STEAM_LAUNCH || STEAM + '/launch.json';
const PFX = HERE + '/prefix';
const HOME = HERE + '/home';
const DXVK = HERE + '/dxvk';
const UID = 12990;
const DLLS = ['d3d11', 'd3d10core', 'd3d9', 'dxgi'];
const PROGRAMS = ['t_d3d1164.exe', 't_d3d964.exe'];

function say(s) { process.stdout.write('dxvk: ' + s + '\n'); }
function crumb(s) {
    /* into the gate's crumbs file too (fd 3), so a hang shows which step */
    try { fs.writeSync(3, (Date.now() / 1000).toFixed(3) + ' [' + process.pid + '] run.js: ' + s + '\n'); } catch (e) { /* no fd 3 */ }
}

function findLaunch() {
    const tries = [LAUNCH];
    /* the tool keeps launch.json beside its server.js; look where mgu-deploy installs */
    ['/var/opt/vizualyse-steam/tool', '/var/opt/vizualyse-steam/app', '/var/opt/vizualyse-steam/current'].forEach((d) => tries.push(d + '/launch.json'));
    for (let i = 0; i < tries.length; i++) if (fs.existsSync(tries[i])) return tries[i];
    const r = cp.spawnSync('find', [STEAM, '/var/opt/mgu-deploy', '-maxdepth', '5', '-name', 'launch.json'], { encoding: 'utf8' });
    const f = (r.stdout || '').split('\n').filter((l) => l)[0];
    return f || null;
}

/* ---- setup (root) --------------------------------------------------------- */

function setup() {
    if (process.getuid() !== 0) { say('setup runs as root'); return 2; }
    const src = STEAM + '/prefix';
    if (!fs.existsSync(src + '/pfx/drive_c/windows/system32')) { say('no Steam prefix at ' + src + ' (install Steam and start it once)'); return 2; }
    const launch = findLaunch();
    if (!launch) { say('no launch.json of the Steam tool found'); return 2; }
    say('launch.json: ' + launch);
    fs.writeFileSync(HERE + '/launch.path', launch + '\n');
    const sh = (c) => { const r = cp.spawnSync('/bin/sh', ['-c', c], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(c + ': exit ' + r.status); };
    sh('rm -rf "' + PFX + '" "' + HOME + '" && cp -a "' + src + '" "' + PFX + '" && mkdir -p "' + HOME + '/tmp"');
    const win = PFX + '/pfx/drive_c/windows';
    [['x64', 'system32'], ['x32', 'syswow64']].forEach((a) => {
        if (!fs.existsSync(win + '/' + a[1])) return;
        DLLS.forEach((d) => sh('cp "' + DXVK + '/' + a[0] + '/' + d + '.dll" "' + win + '/' + a[1] + '/' + d + '.dll"'));
    });
    sh('chown -R ' + UID + ':' + UID + ' "' + PFX + '" "' + HOME + '"');
    const du = cp.spawnSync('du', ['-sh', PFX], { encoding: 'utf8' }).stdout.trim();
    say('prefix ready: ' + du + ', DXVK ' + fs.readFileSync(DXVK + '/VERSION', 'utf8').trim() + ' in system32' +
        (fs.existsSync(win + '/syswow64') ? ' and syswow64' : ''));
    return 0;
}

/* ---- run (the gate's child) ---------------------------------------------- */

/* the test programs' T_LOG is a Windows text file: \r\n */
function readLines(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) { return []; } }

function waitFor(cond, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        cp.spawnSync('sleep', ['1']);
    }
    return cond();
}

function run() {
    if (process.getuid() !== UID) { say('run as the gate\'s child (uid ' + UID + ')'); return 2; }
    const launchFile = (function () { try { return fs.readFileSync(HERE + '/launch.path', 'utf8').trim(); } catch (e) { return findLaunch(); } })();
    const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    const stub = !!process.env.INTEL_STUB_GPU_PLATFORM;
    const tmp = fs.mkdtempSync('/tmp/vkt-dxvk-');
    fs.chmodSync(tmp, 0o700);
    const xdg = tmp + '/xdg';
    fs.mkdirSync(xdg, 0o700);
    say('logs in ' + tmp + (stub ? ' (the bench\'s stub GPU: pixels not checked)' : ''));

    /* wl-sink, offscreen: the frame file and the last picture here */
    const sinkLog = fs.openSync(tmp + '/wl-sink.log', 'a');
    const sinkEnv = Object.assign({}, process.env, { XDG_RUNTIME_DIR: xdg, LD_LIBRARY_PATH: STEAM + '/gpu-libs:/usr/lib' });
    crumb('starting wl-sink');
    const sink = cp.spawn(VKT + '/bin/wl-sink', ['--socket', 'wayland-1', '--frame', tmp + '/frame', '--create', '640x360', '--snap', tmp + '/snap.ppm'],
        { env: sinkEnv, stdio: ['pipe', sinkLog, sinkLog] });
    if (!waitFor(() => fs.existsSync(xdg + '/wayland-1'), 10000)) { say('FAIL wl-sink did not start: ' + readLines(tmp + '/wl-sink.log').join(' | ')); sink.kill(); return 1; }
    say('wl-sink: ' + readLines(tmp + '/wl-sink.log')[0]);

    /* Wine as the tool starts it (env.js wineEnv), with our prefix, ANV, DXVK */
    const protonLibs = (launch.env.LD_LIBRARY_PATH || '').split(':').filter((p) => p && p.indexOf(STEAM + '/proton') === 0);
    const e = Object.assign({}, launch.env, {
        PATH: STEAM + '/proton/files/bin:/usr/bin:/bin',
        HOME: HOME, TMPDIR: HOME + '/tmp', XDG_RUNTIME_DIR: xdg,
        XDG_CACHE_HOME: HOME + '/.cache', XDG_CONFIG_HOME: HOME + '/.config', XDG_DATA_HOME: HOME + '/.local/share',
        FONTCONFIG_FILE: STEAM + '/runtime/etc/fonts/fonts.conf',
        LD_LIBRARY_PATH: [VKT + '/lib', STEAM + '/gpu-libs', STEAM + '/runtime/lib'].concat(protonLibs).join(':'),
        LIBGL_DRIVERS_PATH: '/usr/lib/dri',
        WAYLAND_DISPLAY: 'wayland-1',
        WINEPREFIX: PFX + '/pfx/', STEAM_COMPAT_DATA_PATH: PFX, STEAM_COMPAT_CLIENT_INSTALL_PATH: HOME + '/steam',
        SteamGameId: '0', SteamAppId: '0', STEAM_COMPAT_APP_ID: '0',
        WINEDEBUG: 'err+all,fixme-all',
        DXVK_LOG_LEVEL: 'info', DXVK_LOG_PATH: tmp, DXVK_STATE_CACHE_PATH: tmp,
        T_LOG: 'Z:' + tmp.replace(/\//g, '\\') + '\\t.log',
        T_D3D11_CHECK_PIXELS: stub ? '0' : '1', T_D3D9_CHECK_PIXELS: stub ? '0' : '1',
        /* the gate's: ANV's ICD in /run, the crumbs, the bench's stand-ins */
        VK_ICD_FILENAMES: process.env.VK_ICD_FILENAMES || '', LD_PRELOAD: process.env.LD_PRELOAD || '',
        VK_TRIAL_CRUMB_FD: '3'
    });
    if (process.env.INTEL_STUB_GPU_PLATFORM) e.INTEL_STUB_GPU_PLATFORM = process.env.INTEL_STUB_GPU_PLATFORM;
    delete e.DXVK_ENABLE_NVAPI;
    e.WINEDLLOVERRIDES = (e.WINEDLLOVERRIDES ? e.WINEDLLOVERRIDES + ';' : '') + 'mshtml=;winealsa.drv=d;' + DLLS.join(',') + '=n';

    let failed = 0;
    PROGRAMS.forEach((p) => {
        const exe = HERE + '/win/' + p;
        try { fs.writeFileSync(tmp + '/t.log', ''); } catch (err) { /* new */ }
        const t0 = Date.now();
        crumb('wine: ' + p);
        const r = cp.spawnSync(launch.argv[0], launch.argv.slice(1).concat([exe]),
            { env: e, cwd: path.dirname(exe), stdio: ['ignore', fs.openSync(tmp + '/' + p + '.wine.log', 'a'), fs.openSync(tmp + '/' + p + '.wine.log', 'a'), 3],
              timeout: 150000 });
        const lines = readLines(tmp + '/t.log').filter((l) => l);
        lines.forEach((l) => say('  ' + l));
        const ok = lines.some((l) => / ok$/.test(l));
        say(p + ': ' + (ok ? 'ok' : 'FAILED') + ' (exit ' + (r.status === null ? r.signal : r.status) + ', ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
        if (!ok) {
            failed++;
            readLines(tmp + '/' + p + '.wine.log').filter((l) => /err:|DXVK|vulkan/i.test(l)).slice(-12).forEach((l) => say('  wine: ' + l.slice(0, 200)));
        }
        cp.spawnSync(STEAM + '/proton/files/bin/wineserver', ['-k'], { env: e });
    });
    readLines(tmp + '/t_d3d1164_d3d11.log').concat(readLines(tmp + '/t_d3d1164_dxgi.log'))
        .filter((l) => /DXVK: v|Feature level|err:/.test(l)).slice(0, 8).forEach((l) => say('  dxvk: ' + l));

    /* wl-sink: its counts (drm/shm are totals), then the picture */
    cp.spawnSync('sleep', ['2']);
    sink.kill('SIGTERM');
    waitFor(() => sink.exitCode !== null || sink.signalCode !== null, 3000);
    const stats = readLines(tmp + '/wl-sink.log').filter((l) => l.indexOf('"ev":"stats"') >= 0);
    const last = stats[stats.length - 1] || '';
    const num = (k) => { const m = new RegExp('"' + k + '":(\\d+)').exec(last); return m ? +m[1] : 0; };
    say('wl-sink: ' + num('drm') + ' GPU (wl_drm) and ' + num('shm') + ' shared-memory buffers');
    if (!num('drm')) { say('FAIL no GPU buffer reached wl-sink'); failed++; }
    say(failed ? 'FAILED (' + failed + ')' : 'ok');
    return failed ? 1 : 0;
}

const mode = process.argv[2];
process.exitCode = mode === 'setup' ? setup() : mode === 'run' ? run() : (say('usage: run.js setup|run'), 2);
