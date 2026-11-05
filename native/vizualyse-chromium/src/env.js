// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Where the bundle lives and the environment Chromium runs in.
 *
 * The bundle (build/chromium.tgz, tools/bundle.sh) is unpacked at BUNDLE: its
 * chromium and chromium-sink ask for BUNDLE/lib/ld-linux-x86-64.so.2 by
 * absolute path, so it can live nowhere else. Every library comes from
 * BUNDLE/lib (LD_LIBRARY_PATH): the unit's own Mesa 19 / glibc 2.27 are
 * never loaded. The Vulkan driver is ANV (Mesa 25: WebGPU and ANGLE on the
 * GPU); CHROMIUM_VK_ICD swaps it for Chromium's SwiftShader in the off-car
 * tests (no Intel GPU there).
 */
'use strict';

const path = require('path');

const ROOT = '/var/opt/vizualyse-chromium';
const BUNDLE = ROOT + '/chromium';
const PROFILE = process.env.CHROMIUM_PROFILE || ROOT + '/profile';
const STATE_DIR = process.env.CHROMIUM_STATE || ROOT + '/state';

const ICDS = {
    anv: BUNDLE + '/share/vulkan/icd.d/intel_icd.json',
    swiftshader: BUNDLE + '/vk_swiftshader_icd.json',
};

function icd() {
    const v = process.env.CHROMIUM_VK_ICD || 'anv';
    return ICDS[v] || v;
}

function chromiumEnv() {
    return {
        PATH: '/usr/bin:/bin',
        HOME: PROFILE,
        XDG_CONFIG_HOME: path.join(PROFILE, 'config'),
        XDG_CACHE_HOME: path.join(PROFILE, 'cache'),
        TMPDIR: path.join(PROFILE, 'tmp'),
        LANG: 'C.UTF-8',
        LD_LIBRARY_PATH: BUNDLE + '/lib',
        VK_ICD_FILENAMES: icd(),
        VK_DRIVER_FILES: icd(),
        __EGL_VENDOR_LIBRARY_FILENAMES: BUNDLE + '/share/glvnd/egl_vendor.d/50_mesa.json',
        LIBGL_DRIVERS_PATH: BUNDLE + '/lib/dri',
        GBM_BACKENDS_PATH: BUNDLE + '/lib/gbm',
        FONTCONFIG_FILE: BUNDLE + '/etc/fonts/fonts.conf',
        /* Mesa's shader cache, in the profile (its cap: the profile's budget) */
        MESA_SHADER_CACHE_DIR: path.join(PROFILE, 'cache', 'mesa'),
        MESA_SHADER_CACHE_MAX_SIZE: '64M',
    };
}

module.exports = { ROOT, BUNDLE, PROFILE, STATE_DIR, chromiumEnv, icd };
