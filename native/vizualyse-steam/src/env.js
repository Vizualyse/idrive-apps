// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Where everything lives on the unit, and the environments the tool's
 * programs run in (tools/bundle.sh builds what is unpacked here).
 *
 *   /var/opt/vizualyse-steam/
 *     runtime/   glibc 2.41 + loader, the libraries, wl-sink, .NET,
 *                DepotDownloader, ALSA / fontconfig config, CA bundle (root's)
 *     proton/    GE-Proton, trimmed; its programs on runtime's loader (root's)
 *     prefix/    the Windows prefix (the tool's uid: Wine insists the prefix
 *                is the user's own); unpacked once, kept over updates (saves)
 *     games/     one folder per Steam app id (the tool's uid), or on the hard
 *                disk (/var/opt/hdshare/vizualyse-steam/games) by setting
 *     home/      HOME: DepotDownloader's remembered login, caches (the uid's)
 *     gpu-libs/  links to the unit's own Mesa 19 (root's): libEGL, libgbm,
 *                libglapi, libGLESv2, ahead of the runtime's libraries
 *     state/     settings, token, the library (root's)
 *
 * Every program of ours asks for runtime/lib/ld-linux-x86-64.so.2 by path;
 * LD_LIBRARY_PATH is set only on their exec, never on the unit's own shell
 * or Node (glibc 2.27).
 *
 * The GPU: Wine and wl-sink draw on the unit's OWN Mesa 19 (libEGL and the
 * i965 driver, what the HMI and mgu-render use), never a driver of ours
 * (0.1.1 of the browser hung the kernel with one: knowledge/browser.md).
 * Mesa 19 runs on the runtime's newer libwayland (Wine's Wayland driver
 * needs >= 1.20; the unit has 1.15), libdrm and libstdc++; what the runtime
 * lacks (libdrm_intel, libpciaccess) comes from the unit's /usr/lib by the
 * loader's default path, as for the browser's GPU mode.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.STEAM_ROOT || '/var/opt/vizualyse-steam';
const RUNTIME = ROOT + '/runtime';
const PROTON = ROOT + '/proton';
const PREFIX = ROOT + '/prefix';
const HOME = ROOT + '/home';
const GPU_LIBS = ROOT + '/gpu-libs';
const STATE_DIR = process.env.STEAM_STATE || ROOT + '/state';
const INTERNAL_GAMES = ROOT + '/games';
const DISK = process.env.STEAM_DISK || '/var/opt/hdshare';
const DISK_GAMES = DISK + '/vizualyse-steam/games';
const LOADER = RUNTIME + '/lib/ld-linux-x86-64.so.2';
/* the run-time folder: wl-sink's socket, Wine's XDG_RUNTIME_DIR, the sound FIFO
 * (the runtime's asound.conf names it), the resolver file (libc.so.6 reads it) */
const RUN_DIR = process.env.STEAM_RUN_DIR || '/dev/shm/vizualyse-steam';
const PCM_FIFO = RUN_DIR + '/pcm';
const XDG_DIR = RUN_DIR + '/xdg';
/* the controllers' state (steam-pads writes, our xinput1_4.dll reads: src/vzs_pads.h) */
const PADS_FILE = RUN_DIR + '/pads';
const DNS_FILE = process.env.STEAM_DNS_FILE || '/dev/shm/vzs.dns';
const UNIT_LIB = process.env.STEAM_UNIT_LIB || '/usr/lib';
const RENDER_NODE = process.env.STEAM_RENDER_NODE || '/dev/dri/renderD128';
/* Winston's socket (the head unit's compositor): wl-sink connects to it at
 * start, while still root, to show pictures straight on the screen */
const WINSTON_SOCKET = process.env.STEAM_WINSTON || '/run/wayland/wayland-0';
/* the unit's Mesa 19, ahead of the runtime: these four only (not its
 * libwayland 1.15 or libdrm: the runtime's newer ones serve Mesa too) */
const UNIT_GL = ['libEGL.so.1', 'libgbm.so.1', 'libglapi.so.0', 'libGLESv2.so.2'];

/* Vulkan for the games (per game; the default for 64-bit ones): Mesa
 * 19.0.6's ANV, its loader, vk_crumbs.so and DXVK 1.9.4 from vulkan.tgz
 * (tools/vulkan.sh, unpacked into VULKAN; runtime.tgz still carries no GPU
 * driver: bundle.sh checks). STEAM_VK_TRIAL: tools/vk-trial's install
 * instead (its layout). Its ICD exists only in RUN_DIR (tmpfs) while such a
 * game runs; every DRM call of the game is logged to VK.crumbsLog so a hang
 * leaves a trace. knowledge/browser.md, "Vulkan on this kernel". */
const VULKAN = ROOT + '/vulkan';
const VK_BASE = process.env.STEAM_VK_TRIAL || VULKAN;
const VK = {
    driver: VK_BASE + '/lib/libvulkan_intel.so', lib: VK_BASE + '/lib', crumbs: VK_BASE + '/lib/vk_crumbs.so',
    dxvk: process.env.STEAM_VK_TRIAL ? VK_BASE + '/dxvk/dxvk' : VK_BASE + '/dxvk',
    icd: RUN_DIR + '/vk_icd.json', crumbsLog: STATE_DIR + '/vulkan-crumbs.log',
    conf: RUN_DIR + '/dxvk.conf',
    dlls: ['d3d11', 'd3d10core', 'd3d9', 'dxgi'],
    mesa: VK_BASE + '/lib/mesa',   /* the ANV's Mesa version (vulkan.tgz since the candidates; 19 when absent) */
};

/* DXVK's options for every game on Vulkan (VK.conf while one runs; DXVK
 * 1.9.4's names, all seen in its DLLs):
 * - the frame rate the tool shows (fps): no frame drawn that would be thrown
 *   away, its time left to the HMI and the passively cooled unit;
 * - one frame queued ahead, not three: less memory, less input lag;
 * - two shader compilers, not one per core: the game's threads and the HMI
 *   keep two of the four Atom cores while pipelines compile;
 * - no anisotropic filtering, whatever the game asks: texture bandwidth the
 *   HD 505 shares with the HMI;
 * - the adapter WineD3D reports (bundle.sh's prefix): HD Graphics 510
 *   (8086:1902, the nearest Gen9 games know; the real 8086:5a84 is in few
 *   tables) with 1024 MB, not ANV's 4209 MB of shared memory, so games that
 *   pick their settings by the adapter pick low ones on either renderer.
 *   d3d9.maxAvailableMemory only reports (d3d9.memoryTrackTest stays off). */
const ADAPTER = { vendor: '8086', device: '1902', desc: 'Intel(R) HD Graphics 510', memMb: 1024 };
function dxvkConf(fps) {
    return [
        'dxgi.maxFrameRate = ' + fps, 'd3d9.maxFrameRate = ' + fps,
        'dxgi.maxFrameLatency = 1', 'd3d9.maxFrameLatency = 1',
        'dxvk.numCompilerThreads = 2',
        'd3d11.samplerAnisotropy = 0', 'd3d9.samplerAnisotropy = 0',
        'dxgi.customVendorId = ' + ADAPTER.vendor, 'dxgi.customDeviceId = ' + ADAPTER.device,
        'dxgi.customDeviceDesc = "' + ADAPTER.desc + '"', 'dxgi.maxDeviceMemory = ' + ADAPTER.memMb,
        'd3d9.customVendorId = ' + ADAPTER.vendor, 'd3d9.customDeviceId = ' + ADAPTER.device,
        'd3d9.customDeviceDesc = "' + ADAPTER.desc + '"', 'd3d9.maxAvailableMemory = ' + ADAPTER.memMb,
    ].join('\n') + '\n';
}
function vulkanMissing() {
    return [VK.driver, VK.lib + '/libvulkan.so.1', VK.crumbs, VK.dxvk + '/x64/d3d11.dll', VK.dxvk + '/x32/d3d11.dll']
        .filter((f) => !fs.existsSync(f));
}
/* the ANV's Mesa major version: 19 for the shipped one (no lib/mesa before the candidates) */
function vulkanMesaMajor() {
    try { return parseInt(fs.readFileSync(VK.mesa, 'utf8'), 10) || 19; } catch (e) { return 19; }
}

/* GPU_LIBS, made again each time (root's, readable by all): links to the
 * unit's GL libraries. Returns what is missing on this unit. */
function gpuLibs() {
    const missing = UNIT_GL.filter((n) => !fs.existsSync(path.join(UNIT_LIB, n))).map((n) => path.join(UNIT_LIB, n));
    if (missing.length) return missing;
    if (!fs.existsSync(GPU_LIBS)) fs.mkdirSync(GPU_LIBS, 0o755);
    UNIT_GL.forEach((n) => {
        const link = path.join(GPU_LIBS, n);
        try { fs.unlinkSync(link); } catch (e) { /* new */ }
        fs.symlinkSync(path.join(UNIT_LIB, n), link);
    });
    return [];
}

/* Off the car only (test/unit_test.js): the GPU bench's stand-ins, as
 * STEAM_EXTRA_ENV (JSON: LD_PRELOAD of the DRM shim, ...) and
 * STEAM_EXTRA_LIBS (a folder ahead of the unit's GL: llvmpipe). */
const EXTRA_ENV = (function () { try { return JSON.parse(process.env.STEAM_EXTRA_ENV || '{}'); } catch (e) { return {}; } })();
const EXTRA_LIBS = process.env.STEAM_EXTRA_LIBS ? process.env.STEAM_EXTRA_LIBS + ':' : '';

/* What the unit's Mesa needs to find its driver and keep its shader cache. */
function mesaEnv(e) {
    e.LIBGL_DRIVERS_PATH = process.env.STEAM_DRI_PATH || UNIT_LIB + '/dri';
    e.MESA_GLSL_CACHE_DIR = HOME + '/.cache/mesa';
    e.MESA_GLSL_CACHE_MAX_SIZE = '256M';
    return Object.assign(e, EXTRA_ENV);
}

/* Every program of ours: the runtime's libraries, never the unit's shell's. */
function baseEnv() {
    return {
        PATH: '/usr/bin:/bin',
        HOME: HOME,
        TMPDIR: HOME + '/tmp',
        LANG: 'C.UTF-8',
        XDG_RUNTIME_DIR: XDG_DIR,
        XDG_CACHE_HOME: HOME + '/.cache',
        XDG_CONFIG_HOME: HOME + '/.config',
        XDG_DATA_HOME: HOME + '/.local/share',
        LD_LIBRARY_PATH: RUNTIME + '/lib',
        FONTCONFIG_FILE: RUNTIME + '/etc/fonts/fonts.conf',
        SSL_CERT_FILE: RUNTIME + '/etc/ssl/certs/ca-certificates.crt',
        ALSA_CONFIG_PATH: RUNTIME + '/share/alsa/alsa.conf',
        ALSA_CONFIG_DIR: RUNTIME + '/share/alsa',
    };
}

/* wl-sink: the unit's EGL ahead of the runtime (it imports Wine's frames on the GPU). */
function sinkEnv() {
    const e = baseEnv();
    e.LD_LIBRARY_PATH = EXTRA_LIBS + GPU_LIBS + ':' + RUNTIME + '/lib';
    if (process.env.STEAM_SINK_DEBUG) e.WL_SINK_DEBUG = '1';   /* its buffers' state each second (tests) */
    return mesaEnv(e);
}

/* DepotDownloader on .NET: no ICU (InvariantGlobalization), OpenSSL from the
 * runtime, CA bundle in SSL_CERT_FILE, no telemetry. */
function dotnetEnv() {
    const e = baseEnv();
    e.DOTNET_ROOT = RUNTIME + '/dotnet';
    e.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = '1';
    e.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
    e.DOTNET_gcServer = '0';
    /* a smaller heap: the unit has ~5.6 GB for everything */
    e.DOTNET_GCHeapHardLimit = '0x30000000';
    return e;
}

/* Wine for a game, as Proton starts it (build/launch.json, captured from
 * Proton's own launcher at build time), here: the unit's EGL first, the
 * runtime's libraries, then Proton's own. */
function wineEnv(launch, appId, display, vulkan) {
    const e = Object.assign({}, launch.env, baseEnv());
    const protonLibs = (launch.env.LD_LIBRARY_PATH || '').split(':').filter((p) => p && p.indexOf(PROTON) === 0);
    e.LD_LIBRARY_PATH = EXTRA_LIBS + [GPU_LIBS, RUNTIME + '/lib'].concat(protonLibs).join(':');
    e.PATH = PROTON + '/files/bin:/usr/bin:/bin';
    e.WAYLAND_DISPLAY = display;
    e.WINEPREFIX = PREFIX + '/pfx/';
    e.STEAM_COMPAT_DATA_PATH = PREFIX;
    e.STEAM_COMPAT_CLIENT_INSTALL_PATH = ROOT + '/steam';
    e.SteamGameId = e.SteamAppId = String(appId);
    e.STEAM_COMPAT_APP_ID = String(appId);
    e.WINEDEBUG = process.env.STEAM_WINEDEBUG || 'err+all,fixme-all';
    /* no Gecko in the bundle: without this a program that asks for it waits
     * on an installer's dialog nobody can press. mscoree stays on (only
     * bundle.sh's wineboot turns it off): Wine's loader needs its built-in
     * mscoree.dll to load any IL-only DLL, even for a modern .NET game with
     * its own runtime. Slay the Spire 2 (Godot, .NET 9) crashed on the car
     * with "mscoree.dll not found, IL-only binary sts2.dll cannot be loaded"
     * (2026-11-07). A .NET Framework game still has no Wine Mono. */
    e.WINEDLLOVERRIDES = (e.WINEDLLOVERRIDES ? e.WINEDLLOVERRIDES + ';' : '') + 'mshtml=' +
        /* our XInput (src/xinput.c, server.js installXInput): Wine's reads its
         * winebus, which has nothing to read on the car */
        ';xinput1_1,xinput1_2,xinput1_3,xinput1_4,xinput9_1_0=n';
    /* Direct3D: WineD3D on OpenGL (builtin, as ever), or for a game with
     * Vulkan on, DXVK (native, installed in the prefix by server.js) on ANV,
     * named only here through its ICD; vk-trial's loader (the runtime has none) */
    e.WINEDLLOVERRIDES += ';' + VK.dlls.join(',') + (vulkan ? '=n' : '=b');
    if (vulkan) {
        e.VK_ICD_FILENAMES = VK.icd;
        e.LD_LIBRARY_PATH = VK.lib + ':' + e.LD_LIBRARY_PATH;
        e.DXVK_LOG_LEVEL = 'warn';
        e.DXVK_LOG_PATH = 'none';   /* warnings to stderr (the tool's log), no files in the game's folder */
        e.DXVK_STATE_CACHE_PATH = HOME + '/.cache';
        /* read by DXVK through Windows' file calls: the prefix's Z: is / */
        e.DXVK_CONFIG_FILE = 'Z:' + VK.conf.split('/').join('\\');
        e.VK_TRIAL_CRUMB_FD = '3';
    }
    /* OpenGL (WineD3D, a native GL game): Proton's Wine asks Mesa for swap
     * interval 0 ("HACK: Using swap interval 0"), so nothing holds it back and
     * it draws frames wl-sink never shows. Mesa 19's EGL takes vblank_mode 3
     * ("always sync": the i965 driver's option, as an environment variable) as
     * at least 1 whatever is asked, so each swap waits for wl-sink's frame
     * callback, answered at the tool's frame rate (wl-sink --fps). */
    e.vblank_mode = '3';
    mesaEnv(e);
    /* vk_crumbs.so first, ahead of any preload the bench adds (STEAM_EXTRA_ENV, applied by mesaEnv) */
    if (vulkan) e.LD_PRELOAD = [VK.crumbs].concat((e.LD_PRELOAD || '').split(':').filter((p) => p && !/vk_crumbs\.so$/.test(p))).join(':');
    return e;
}

/* The folders baseEnv names, for the uid, before any program of ours runs
 * as it (root, as the tool): RUN_DIR (root's, readable by all), XDG_DIR and
 * HOME's tmp and caches (the uid's, 0700). /dev/shm is empty after every
 * start of the unit: DepotDownloader run before any game found no XDG_DIR,
 * and .NET's named mutex there (IsolatedStorage) aborted it (2026-11-07). */
function userDirs(uid, gid) {
    [RUN_DIR, XDG_DIR].forEach((d) => { try { fs.mkdirSync(d, 0o755); } catch (e) { /* there */ } });
    fs.chmodSync(RUN_DIR, 0o755);
    fs.chownSync(XDG_DIR, uid, gid);
    fs.chmodSync(XDG_DIR, 0o700);
    ['tmp', '.cache', '.cache/mesa'].forEach((d) => {
        const p = path.join(HOME, d);
        try { fs.mkdirSync(p, 0o700); } catch (e) { /* there */ }
        fs.chownSync(p, uid, gid);
    });
}

module.exports = {
    ROOT, RUNTIME, PROTON, PREFIX, HOME, GPU_LIBS, STATE_DIR, INTERNAL_GAMES, DISK, DISK_GAMES, LOADER,
    RUN_DIR, PCM_FIFO, XDG_DIR, PADS_FILE, DNS_FILE, RENDER_NODE, UNIT_LIB, WINSTON_SOCKET, VK, VULKAN, vulkanMissing, vulkanMesaMajor, dxvkConf,
    gpuLibs, userDirs, baseEnv, sinkEnv, dotnetEnv, wineEnv,
};
