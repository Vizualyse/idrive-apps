// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool left running in the head unit's own root filesystem, to play a
 * real game off the car (test/run_play.sh starts it): server.js as on the
 * car, with the internet for DepotDownloader, its phone page on the PC's
 * localhost, /var/opt kept in a Docker volume (the bundles unpacked, the
 * sign-in, the games, the prefix) and the GPU bench's stand-in for the GPU
 * (GPU=stub: the unit's own drivers on a fake HD 505, every CPU-side step
 * real, the GPU itself taking no time and drawing nothing).
 *
 *   node play_main.js /t        (/t: the tool's folder, /g: tools/gpu-bench/build,
 *                                /vkt: tools/vk-trial/build)
 *
 * What it is for: the limits of our own layers (Wine, DXVK / WineD3D, the
 * drivers' CPU side, the crumbs logger, wl-sink's pacing, memory), read from
 * the tool's own "perf:" lines. Not the Atom's speed, nor the GPU's.
 *
 * PLAY_CRUMBS=off: a Vulkan game's DRM calls are not logged (vk_crumbs.so
 * stays loaded and passes them on); PLAY_CRUMBS=all: every call written as
 * it happens, as the tool did up to 0.2.3 (not its watch mode): to compare.
 * PLAY_SYNC=fsync: Wine's fsync, which the car's kernel hasn't (the
 * server's own here by default, as there). PLAY_FAKE=t_d3d964.exe: the unit test's stand-in for
 * DepotDownloader, which installs that test program (build/win) as the game
 * and lets it draw for as long as it runs: this bench checked without Steam.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const T = process.argv[2] || '/t';
const GPU = process.env.GPU || 'stub';
const ROOT = '/var/opt/vizualyse-steam';

/* the container's own resolver and address, as the phone's lease on the car */
function nameservers() {
    try {
        return fs.readFileSync('/etc/resolv.conf', 'utf8').split('\n')
            .map((l) => /^nameserver\s+(\d+\.\d+\.\d+\.\d+)/.exec(l)).filter(Boolean).map((m) => m[1]);
    } catch (e) { return []; }
}
function address() {
    const ifs = os.networkInterfaces();
    for (const n of Object.keys(ifs)) {
        const a = ifs[n].filter((x) => x.family === 'IPv4' && !x.internal)[0];
        if (a) return a.address;
    }
    return '127.0.0.1';
}
const dns = nameservers();
fs.writeFileSync('/tmp/lease.json', JSON.stringify({ ip: address(), dns: dns, router: dns[0] || '127.0.0.1' }));

const extra = { LD_PRELOAD: '/g/stub/libintel_noop_drm_shim.so', INTEL_STUB_GPU_PLATFORM: 'bxt' };
/* kernel414: the unit's kernel's answers, for the bundled ANV (as test/unit_test.js) */
if (fs.existsSync('/vkt/bench/kernel414.so') && GPU !== 'swrast') extra.LD_PRELOAD = '/vkt/bench/kernel414.so:' + extra.LD_PRELOAD;
if (process.env.PLAY_CRUMBS === 'off') extra.VK_TRIAL_CRUMB_FD = '-1';
if (process.env.PLAY_CRUMBS === 'all') extra.VK_TRIAL_CRUMB_MODE = 'all';
/* Wine's synchronisation as on the car: its 4.14 kernel has no futex_waitv
 * (fsync) and no ntsync, and this Wine has no esync, so there every wait
 * goes through wineserver; this PC's kernel has fsync, which launch.json
 * would turn on. PLAY_SYNC=fsync keeps it. */
if (process.env.PLAY_SYNC !== 'fsync') { extra.WINEFSYNC = '0'; extra.WINENTSYNC = '0'; }
/* PLAY_UNCAPPED=1: a DXVK game as fast as it can go, to see what a change
 * costs in frames: at the tool's 30 or 60 a fast PC waits out the rest of
 * every frame and hides it. DXVK's options as env.js writes them, but no
 * frame limit and no waiting for the compositor (vsync off, so wl-sink's
 * tick doesn't pace it either). */
if (process.env.PLAY_UNCAPPED) {
    fs.writeFileSync('/var/opt/play-uncapped.conf', ['dxgi.maxFrameRate = 0', 'd3d9.maxFrameRate = 0', 'dxgi.syncInterval = 0', 'd3d9.presentInterval = 0',
        'dxgi.maxFrameLatency = 1', 'd3d9.maxFrameLatency = 1', 'dxvk.numCompilerThreads = 2', 'd3d11.samplerAnisotropy = 0', 'd3d9.samplerAnisotropy = 0',
        'dxgi.customVendorId = 8086', 'dxgi.customDeviceId = 1902', 'dxgi.customDeviceDesc = "Intel(R) HD Graphics 510"', 'dxgi.maxDeviceMemory = 1024',
        'd3d9.customVendorId = 8086', 'd3d9.customDeviceId = 1902', 'd3d9.customDeviceDesc = "Intel(R) HD Graphics 510"', 'd3d9.maxAvailableMemory = 1024'].join('\n') + '\n');
    extra.DXVK_CONFIG_FILE = 'Z:\\var\\opt\\play-uncapped.conf';
}
const senv = Object.assign({}, process.env, {
    STEAM_NO_FIREWALL: '1', STEAM_LEASE: '/tmp/lease.json', STEAM_CTL_SOCKET: '/tmp/ctl/ctl.sock',
    STEAM_SWAP_MB: '0',
    STEAM_RUNTIME_ARCHIVE: T + '/build/runtime.tgz', STEAM_PROTON_ARCHIVE: T + '/build/proton.tgz',
    STEAM_PREFIX_ARCHIVE: T + '/build/prefix.tgz', STEAM_VULKAN_ARCHIVE: T + '/build/vulkan.tgz', STEAM_IRIS_ARCHIVE: T + '/build/iris.tgz', STEAM_LAUNCH: T + '/build/launch.json',
    /* mgu-render's client and the display's touches: stand-ins, as the unit test's */
    STEAM_RENDER_CLIENT: T + '/test/fake_render_client.js', STEAM_TEST_RENDER_LOG: '/tmp/render.log',
    STEAM_TOUCH_FILE: '/dev/shm/touch.txt', STEAM_LINK_IP: '127.0.0.1',
});
if (process.env.PLAY_FAKE) {
    senv.STEAM_DD_CMD = '/usr/bin/node ' + T + '/test/fake_dd.js ' + T + '/build/win/' + process.env.PLAY_FAKE;
    extra.T_FRAMES = '1000000';
}
/* GPU=lavapipe: Mesa's CPU Vulkan driver in ANV's place (run_play.sh puts it
 * in the volume, in vk-trial's layout): a Vulkan game's real pictures, by
 * shared memory into wl-sink and the frame file. OpenGL stays on the stub. */
if (GPU === 'lavapipe') senv.STEAM_VK_TRIAL = '/var/opt/lvp';
if (GPU === 'swrast') {
    extra.GBM_ALWAYS_SOFTWARE = '1';
    senv.STEAM_DRI_PATH = '/g/swrast';
    senv.STEAM_EXTRA_LIBS = '/g/swrast';
}
/* PLAY_ENV: more of the game's environment, as JSON, over the tool's own (a try: {"WINE_D3D_CONFIG":"csmt=0"}) */
if (process.env.PLAY_ENV) Object.assign(extra, JSON.parse(process.env.PLAY_ENV));
senv.STEAM_EXTRA_ENV = JSON.stringify(extra);

console.log('play: vizualyse-steam in the unit\'s root filesystem, GPU ' + GPU + ', crumbs ' + (process.env.PLAY_CRUMBS === 'off' ? 'off' : process.env.PLAY_CRUMBS === 'all' ? 'every call written (as up to 0.2.3)' : 'as shipped (watch)') +
    ', DNS ' + (dns.join(', ') || 'none'));
const server = spawn('/usr/bin/node', [T + '/src/server.js'], { env: senv, stdio: ['ignore', 'inherit', 'inherit'] });
server.on('exit', (code, sig) => { console.log('play: the tool exited (' + (sig || code) + ')'); process.exit(code || 0); });
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => { try { server.kill('SIGTERM'); } catch (e) { /* gone */ } }));

/* Where the game's CPU goes, every 10 s while it runs: the threads of the
 * tool's uid (Wine, the game, wl-sink) from /proc, the busiest by name
 * (DXVK names its own: dxvk-cs, dxvk-submit, ...). The tool's own perf lines
 * have the game's CPU only from its memory cgroup, which Docker Desktop's
 * cgroup v2 doesn't give it; and a thread at 100 % is a limit that a total
 * never shows. Bench only: on the car a probe like this disturbs the game. */
const UID = 12996, HZ = 100, EVERY_MS = 10000;
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
            const f = s.slice(s.lastIndexOf(')') + 2).split(' ');   /* after "(comm) ": utime f[11], stime f[12] */
            out[tid] = { proc: proc, name: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), ticks: Number(f[11]) + Number(f[12]) };
        });
    });
    return out;
}
let before = threads(), beforeAt = Date.now();
setInterval(() => {
    const now = threads(), at = Date.now(), s = (at - beforeAt) / 1000;
    const used = Object.keys(now).map((tid) => ({ t: now[tid], pct: 100 * ((now[tid].ticks - (before[tid] ? before[tid].ticks : 0)) / HZ) / s }))
        .filter((x) => x.pct >= 0.5).sort((a, b) => b.pct - a.pct);
    const n = Object.keys(now).length;
    before = now; beforeAt = at;
    if (!n || !used.length) return;
    const total = used.reduce((a, x) => a + x.pct, 0);
    console.log(new Date().toISOString() + ' play: cpu: ' + Math.round(total) + ' % of a core over ' + n + ' threads; busiest: ' +
        used.slice(0, 8).map((x) => (x.t.name === x.t.proc ? x.t.name : x.t.proc + '/' + x.t.name) + ' ' + Math.round(x.pct) + ' %').join(', '));
}, EVERY_MS);

/* the page's link once the tool has made its token */
(function link(n) {
    let t = null;
    try { t = fs.readFileSync(ROOT + '/state/token', 'utf8').trim(); } catch (e) { /* not yet */ }
    if (t) { console.log('play: the page: http://localhost:' + (process.env.STEAM_PORT || 8494) + '/?t=' + t); return; }
    if (n > 0) setTimeout(() => link(n - 1), 200);
})(150);
