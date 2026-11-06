// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Where the bundle lives and the environment Chromium runs in.
 *
 * The bundle (build/chromium.tgz, tools/bundle.sh) is unpacked at BUNDLE: its
 * chromium and chromium-sink ask for BUNDLE/lib/ld-linux-x86-64.so.2 by
 * absolute path, so it can live nowhere else. Every library comes from
 * BUNDLE/lib (LD_LIBRARY_PATH): the unit's own Mesa 19 / glibc 2.27 are
 * never loaded.
 *
 * Vulkan is Chromium's own SwiftShader (the CPU) only, and nothing else can
 * be chosen: the bundle has no GPU driver since 0.1.2. 0.1.1's Mesa 22.3 ANV
 * hung in the unit's 4.14 kernel and blacked out the HMI
 * (knowledge/browser.md).
 */
'use strict';

const path = require('path');

const ROOT = '/var/opt/vizualyse-chromium';
const BUNDLE = ROOT + '/chromium';
const PROFILE = process.env.CHROMIUM_PROFILE || ROOT + '/profile';
const STATE_DIR = process.env.CHROMIUM_STATE || ROOT + '/state';

function icd() {
    return BUNDLE + '/vk_swiftshader_icd.json';
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
        FONTCONFIG_FILE: BUNDLE + '/etc/fonts/fonts.conf',
    };
}

module.exports = { ROOT, BUNDLE, PROFILE, STATE_DIR, chromiumEnv, icd };
