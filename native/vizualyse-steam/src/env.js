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
function wineEnv(launch, appId, display) {
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
    return mesaEnv(e);
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
    RUN_DIR, PCM_FIFO, XDG_DIR, PADS_FILE, DNS_FILE, RENDER_NODE, UNIT_LIB, WINSTON_SOCKET,
    gpuLibs, userDirs, baseEnv, sinkEnv, dotnetEnv, wineEnv,
};
