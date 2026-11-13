// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A PNG of a theme at a moment of the bench drive, drawn by the preview in
 * headless Chrome (WebGL through SwiftShader):
 *   node tools/preview_shot.js <id> <seconds> <out.png> [--chrome PATH]
 * Use it to compare a theme with its mockup and to check a shader compiles.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { serve } = require('./preview_serve.js');

const CHROMES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const [id, secs, out] = process.argv.slice(2);
if (!id || secs == null || !out) { console.error('usage: node tools/preview_shot.js <id> <seconds> <out.png>'); process.exit(2); }
const ci = process.argv.indexOf('--chrome');
const chrome = [ci > 0 ? process.argv[ci + 1] : null].concat(CHROMES).filter((p) => p && fs.existsSync(p))[0];
const port = 8771 + Math.floor(Math.random() * 200);
const server = serve(port, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
    /* async: the server in this process must answer Chrome while it loads */
    const c = spawn(chrome, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
        '--force-device-scale-factor=1', '--virtual-time-budget=8000', '--user-data-dir=' + path.join(tmp, 'p'),
        '--window-size=1920,720', '--screenshot=' + path.resolve(out),
        'http://127.0.0.1:' + port + '/?theme=' + id + '&t=' + secs + '&still']);
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => c.kill(), 120000);
    c.on('exit', () => {
        clearTimeout(kill);
        server.close();
        if (!fs.existsSync(out)) { console.error('no screenshot: ' + err.slice(-600)); process.exit(1); }
        console.log(out);
    });
});
