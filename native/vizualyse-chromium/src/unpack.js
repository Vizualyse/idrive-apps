// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Unpacks the bundle (chromium.tgz, shipped as one file of the tool) at
 * env.BUNDLE, once per bundle: a streaming tar reader (Node 8 has gzip but no
 * tar, and BusyBox's tar is not something to rely on), into BUNDLE.new, then
 * swapped in by rename. BUNDLE/.stamp holds the archive's sha256, so a new
 * release unpacks again and a restart doesn't. Regular files and folders only
 * (the bundle has no links: tools/bundle.sh copies with -L); GNU long names.
 * Entries must sit under the bundle's own path in the archive.
 *
 *   node unpack.js <chromium.tgz>     (by hand; server.js calls ensure())
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const env = require('./env.js');

function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n)));
        fs.rmdirSync(p);
    } else {
        fs.unlinkSync(p);
    }
}

function mkdirp(d, mode) {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d), mode);
    fs.mkdirSync(d, mode || 0o755);
}

function sha256File(file, cb) {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', cb).on('end', () => cb(null, h.digest('hex')));
}

/* The tar stream's entries, written under dest (prefix stripped). cb(err, n files). */
function extract(file, prefix, dest, cb) {
    let buf = Buffer.alloc(0);
    let cur = null;          /* { fd, left, pad } */
    let longName = null;
    let files = 0, failed = false, ended = false;
    const fail = (e) => { if (!failed) { failed = true; cb(e); } };

    const name = (h) => {
        const s = (a, b) => h.toString('latin1', a, b).replace(/\0.*$/, '');
        const p = s(345, 500);
        return (h.toString('latin1', 257, 262) === 'ustar' && p ? p + '/' : '') + s(0, 100);
    };
    const target = (n) => {
        const rel = n.replace(/^\.\//, '').replace(/\/$/, '');
        if (rel === prefix) return dest;
        if (rel.indexOf(prefix + '/') !== 0) throw new Error('entry outside the bundle: ' + n);
        const sub = rel.slice(prefix.length + 1);
        if (sub.split('/').some((x) => x === '..' || x === '')) throw new Error('bad entry: ' + n);
        return path.join(dest, sub);
    };

    const step = () => {
        for (;;) {
            if (cur) {
                if (!buf.length) return;
                const take = Math.min(cur.left, buf.length);
                if (take) {
                    if (cur.fd !== null) fs.writeSync(cur.fd, buf, 0, take);
                    else cur.data.push(Buffer.from(buf.slice(0, take)));
                    cur.left -= take;
                    buf = buf.slice(take);
                }
                if (cur.left) return;
                if (buf.length < cur.pad) return;
                buf = buf.slice(cur.pad);
                if (cur.fd !== null) { fs.closeSync(cur.fd); files++; }
                else longName = Buffer.concat(cur.data).toString('utf8').replace(/\0.*$/, '');
                cur = null;
                continue;
            }
            if (buf.length < 512) return;
            const h = buf.slice(0, 512);
            buf = buf.slice(512);
            if (h.every((b) => b === 0)) { ended = true; return; }
            const size = parseInt(h.toString('latin1', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
            const mode = parseInt(h.toString('latin1', 100, 108).replace(/\0.*$/, '').trim() || '644', 8) & 0o777;
            const type = String.fromCharCode(h[156] || 48);
            const pad = (512 - (size % 512)) % 512;
            if (type === 'L') { cur = { fd: null, data: [], left: size, pad: pad }; continue; }
            const n = longName || name(h);
            longName = null;
            const t = target(n);
            if (type === '5') { mkdirp(t, 0o755); fs.chmodSync(t, mode | 0o700); continue; }
            if (type !== '0' && type !== '\0') throw new Error('unexpected entry type ' + JSON.stringify(type) + ': ' + n);
            mkdirp(path.dirname(t), 0o755);
            cur = { fd: fs.openSync(t, 'w', mode), left: size, pad: pad };
            fs.fchmodSync(cur.fd, mode);
            if (!size) { fs.closeSync(cur.fd); files++; cur = null; }
        }
    };

    fs.createReadStream(file).on('error', fail).pipe(zlib.createGunzip()).on('error', fail)
        .on('data', (d) => {
            if (failed || ended) return;
            buf = buf.length ? Buffer.concat([buf, d]) : d;
            try { step(); } catch (e) { if (cur && cur.fd) { try { fs.closeSync(cur.fd); } catch (x) { /* */ } } fail(e); }
        })
        .on('end', () => {
            if (failed) return;
            if (cur) return fail(new Error('archive ends inside an entry'));
            cb(null, files);
        });
}

/* The bundle unpacked from archive, if it isn't already: cb(err, { unpacked, files, sha }). */
function ensure(archive, log, cb) {
    const dest = env.BUNDLE;
    sha256File(archive, (err, sha) => {
        if (err) return cb(err);
        let stamp = '';
        try { stamp = fs.readFileSync(path.join(dest, '.stamp'), 'utf8').trim(); } catch (e) { /* none */ }
        if (stamp === sha) return cb(null, { unpacked: false, sha: sha });
        log('bundle: unpacking ' + path.basename(archive) + ' (' + sha.slice(0, 12) + ') into ' + dest);
        const tmp = dest + '.new', old = dest + '.old';
        rmrf(tmp);
        const t0 = Date.now();
        extract(archive, dest.replace(/^\//, ''), tmp, (e2, files) => {
            if (e2) { rmrf(tmp); return cb(e2); }
            fs.writeFileSync(path.join(tmp, '.stamp'), sha + '\n');
            rmrf(old);
            if (fs.existsSync(dest)) fs.renameSync(dest, old);
            fs.renameSync(tmp, dest);
            rmrf(old);
            log('bundle: ' + files + ' files in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
            cb(null, { unpacked: true, files: files, sha: sha });
        });
    });
}

module.exports = { ensure, extract, rmrf, mkdirp };

if (require.main === module) {
    ensure(process.argv[2], console.log, (err, r) => {
        if (err) { console.error('unpack: ' + err.message); process.exit(1); }
        console.log(JSON.stringify(r));
    });
}
