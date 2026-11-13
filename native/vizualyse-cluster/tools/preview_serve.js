// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Serves the off-car preview (tools/preview.html) and the built themes on
 * http://127.0.0.1:8770/ (PREVIEW_PORT). /themes lists the built themes.
 *   node tools/preview_serve.js
 * Also used by tools/preview_shot.js, which screenshots a moment of a theme.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const HERE = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
    '.frag': 'text/plain', '.gz': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };

function serve(port, cb) {
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        if (u.pathname === '/themes') {
            const ids = fs.readdirSync(path.join(HERE, 'themes', 'built')).filter((n) => /\.theme\.json$/.test(n)).map((n) => n.split('.')[0]).sort();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(ids));
        }
        const rel = u.pathname === '/' ? 'tools/preview.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
        const file = path.resolve(HERE, rel);
        if (file.indexOf(HERE) !== 0 || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
    });
    server.listen(port, '127.0.0.1', () => cb && cb(server));
    return server;
}

if (require.main === module) {
    const port = Number(process.env.PREVIEW_PORT) || 8770;
    serve(port, () => console.log('preview: http://127.0.0.1:' + port + '/'));
}
module.exports = { serve };
