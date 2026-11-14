// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool kit's build step: downloads John Van Sickle's static ffmpeg for
 * x86-64 Linux (GPLv3; https://johnvansickle.com/ffmpeg/), pinned by
 * version and SHA-256, and unpacks ffmpeg and its GPLv3.txt into build/.
 * Runs on the build machine (Node 18+, `tar` with xz).
 *
 *   node tools/fetch_ffmpeg.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = '7.0.2';
/* The current release lives in releases/, older ones move to old-releases/. */
const URLS = ['releases', 'old-releases'].map((d) => 'https://johnvansickle.com/ffmpeg/' + d + '/ffmpeg-' + VERSION + '-amd64-static.tar.xz');
/* The archive johnvansickle.com published as ffmpeg-release-amd64-static.tar.xz on
 * 2024-08-23 (md5 7fa72b652e19bf84c9461e332ea1cdf3). */
const SHA256 = process.env.FFMPEG_SHA256 || 'abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67';

const out = path.join(__dirname, '..', 'build');

async function main() {
    fs.mkdirSync(out, { recursive: true });
    const bin = path.join(out, 'ffmpeg');
    if (fs.existsSync(bin) && fs.existsSync(path.join(out, 'ffmpeg-GPLv3.txt'))) { console.log('build/ffmpeg present'); return; }
    /* The server once sent other bytes under the same name (CI, 2026-11-13:
     * sha256 1416e990...); the next run got the pinned archive again. So a
     * mismatch is tried again, and only a pin that keeps failing stops. */
    let buf = null, why = 'ffmpeg ' + VERSION + ' not found at ' + URLS.join(' or ');
    for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
        if (attempt > 1) await new Promise((ok) => setTimeout(ok, 15000 * (attempt - 1)));
        for (const url of URLS) {
            console.log('downloading ' + url + (attempt > 1 ? ' (try ' + attempt + ')' : ''));
            let got;
            try {
                const r = await fetch(url);
                if (!r.ok) { console.log('  HTTP ' + r.status); continue; }
                got = Buffer.from(await r.arrayBuffer());
            } catch (e) { console.log('  ' + e.message); why = e.message; continue; }
            const sha = crypto.createHash('sha256').update(got).digest('hex');
            const md5 = crypto.createHash('md5').update(got).digest('hex');
            console.log('  ' + got.length + ' bytes, sha256 ' + sha + ', md5 ' + md5);
            if (SHA256 ? sha === SHA256 : md5 === '7fa72b652e19bf84c9461e332ea1cdf3') { buf = got; break; }
            why = SHA256 ? 'sha256 mismatch: want ' + SHA256 : 'md5 mismatch: not the pinned ' + VERSION + ' archive';
            console.log('  ' + why);
        }
    }
    if (!buf) throw new Error(why);
    const tarball = path.join(out, 'ffmpeg.tar.xz');
    fs.writeFileSync(tarball, buf);
    const dir = 'ffmpeg-' + VERSION + '-amd64-static';
    execFileSync('tar', ['-xJf', tarball, '-C', out, dir + '/ffmpeg', dir + '/GPLv3.txt'], { stdio: 'inherit' });
    fs.renameSync(path.join(out, dir, 'ffmpeg'), bin);
    fs.renameSync(path.join(out, dir, 'GPLv3.txt'), path.join(out, 'ffmpeg-GPLv3.txt'));
    fs.rmSync(path.join(out, dir), { recursive: true, force: true });
    fs.unlinkSync(tarball);
    console.log('build/ffmpeg ready');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
