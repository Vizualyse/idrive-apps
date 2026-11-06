// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Where the bundle lives and the environment Chromium runs in.
 *
 * The bundle (build/chromium.tgz, tools/bundle.sh) is unpacked at BUNDLE: its
 * chromium and chromium-sink ask for BUNDLE/lib/ld-linux-x86-64.so.2 by
 * absolute path, so it can live nowhere else. Every library comes from
 * BUNDLE/lib (LD_LIBRARY_PATH): the unit's own glibc 2.27 is never loaded.
 *
 * Two modes:
 * - CPU (the default, and always at start): Vulkan is Chromium's own
 *   SwiftShader. The bundle has no GPU driver: 0.1.1's Mesa 22.3 ANV hung
 *   in the unit's 4.14 kernel and blacked out the HMI (knowledge/browser.md).
 * - GPU (turned on by hand, never kept): ANGLE on the unit's OWN Mesa 19
 *   EGL / GLES and i965 driver, the stack the HMI and mgu-render use.
 *   GPU_LIBS goes first in LD_LIBRARY_PATH: the bundle's libEGL.so.1 shim
 *   (gpu/egl_shim.c: the render node through GBM) and links to the unit's
 *   libGLESv2, libgbm, libglapi, Wayland and libffi 6, so Mesa 19 gets its
 *   own libraries; everything else stays the bundle's.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = '/var/opt/vizualyse-chromium';
const BUNDLE = ROOT + '/chromium';
const PROFILE = process.env.CHROMIUM_PROFILE || ROOT + '/profile';
const STATE_DIR = process.env.CHROMIUM_STATE || ROOT + '/state';
const GPU_LIBS = ROOT + '/gpu-libs';
const UNIT_LIB = process.env.CHROMIUM_UNIT_LIB || '/usr/lib';
const UNIT_EGL = UNIT_LIB + '/libEGL.so.1';
const RENDER_NODE = process.env.CHROMIUM_RENDER_NODE || '/dev/dri/renderD128';
/* the unit's libraries Mesa 19's libEGL and i965 must get, not the bundle's */
const UNIT_LIBS = ['libGLESv2.so.2', 'libgbm.so.1', 'libglapi.so.0', 'libwayland-client.so.0', 'libwayland-server.so.0', 'libffi.so.6'];

function icd() {
    return BUNDLE + '/vk_swiftshader_icd.json';
}

/* GPU_LIBS, made again each time (root's, readable by all): the shim and
 * links to the unit's GL libraries. Returns what is missing on this unit
 * (then there is no GPU mode). */
function gpuLibs() {
    const want = [['libEGL.so.1', BUNDLE + '/gpu/libEGL.so.1'], ['(unit) libEGL.so.1', UNIT_EGL]]
        .concat(UNIT_LIBS.map((n) => [n, UNIT_LIB + '/' + n]));
    const missing = want.filter((w) => !fs.existsSync(w[1])).map((w) => w[1]);
    if (missing.length) return missing;
    if (!fs.existsSync(GPU_LIBS)) fs.mkdirSync(GPU_LIBS, 0o755);
    want.filter((w) => w[0][0] !== '(').forEach((w) => {
        const link = path.join(GPU_LIBS, w[0]);
        try { fs.unlinkSync(link); } catch (e) { /* new */ }
        fs.symlinkSync(w[1], link);
    });
    return [];
}

function chromiumEnv(gpu) {
    const e = {
        PATH: '/usr/bin:/bin',
        HOME: PROFILE,
        XDG_CONFIG_HOME: path.join(PROFILE, 'config'),
        XDG_CACHE_HOME: path.join(PROFILE, 'cache'),
        TMPDIR: path.join(PROFILE, 'tmp'),
        LANG: 'C.UTF-8',
        LD_LIBRARY_PATH: BUNDLE + '/lib',
        VK_ICD_FILENAMES: icd(),
        VK_DRIVER_FILES: icd(),
        FONTCONFIG_FILE: BUNDLE + '/etc/fonts/fonts.conf',
    };
    if (gpu) {
        e.LD_LIBRARY_PATH = GPU_LIBS + ':' + BUNDLE + '/lib';
        e.CHROMIUM_EGL_REAL = UNIT_EGL;
        e.CHROMIUM_EGL_NODE = RENDER_NODE;
        e.LIBGL_DRIVERS_PATH = UNIT_LIB + '/dri';
        /* Mesa 19's shader cache, in the profile */
        e.MESA_GLSL_CACHE_DIR = path.join(PROFILE, 'cache', 'mesa');
        e.MESA_GLSL_CACHE_MAX_SIZE = '64M';
    }
    return e;
}

module.exports = { ROOT, BUNDLE, PROFILE, STATE_DIR, GPU_LIBS, UNIT_EGL, RENDER_NODE, chromiumEnv, icd, gpuLibs };
