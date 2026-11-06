// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Unpacks the tool's archives (runtime.tgz, proton.tgz, prefix.tgz, shipped
 * as files of the tool) at their places under /var/opt/vizualyse-steam: a
 * streaming tar reader (Node 8 has gzip but no tar, and BusyBox's tar is not
 * something to rely on), into DEST.new, then swapped in by rename. DEST/.stamp
 * holds the archive's sha256, so a new release unpacks again and a restart
 * doesn't. As vizualyse-chromium's, plus symbolic links (Proton's tree and the
 * Windows prefix have thousands): they are made only after every file and
 * folder is written, so nothing is ever written through one. Entries must
 * sit under DEST's own path in the archive.
 *
 *   node unpack.js <archive.tgz> <dest>     (by hand; server.js calls ensure())
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

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

/* Owner of a tree's files and folders. Links are left alone (Node 8 has no
 * lchown, and chown would follow them: into Proton, or z: to /). */
function chownR(p, uid, gid) {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    fs.chownSync(p, uid, gid);
    if (st.isDirectory()) fs.readdirSync(p).forEach((n) => chownR(path.join(p, n), uid, gid));
}

function sha256File(file, cb) {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', cb).on('end', () => cb(null, h.digest('hex')));
}

/* The tar stream's entries, written under dest (prefix stripped). cb(err, { files, links }). */
function extract(file, prefix, dest, cb) {
    let buf = Buffer.alloc(0);
    let cur = null;          /* { fd, left, pad } or { data, left, pad, kind } */
    let longName = null, longLink = null;
    let files = 0, failed = false, ended = false;
    const links = [];        /* [target, at]: made at the end */
    const fail = (e) => { if (!failed) { failed = true; cb(e); } };

    const field = (h, a, b) => h.toString('latin1', a, b).replace(/\0.*$/, '');
    const name = (h) => {
        const p = field(h, 345, 500);
        return (h.toString('latin1', 257, 262) === 'ustar' && p ? p + '/' : '') + field(h, 0, 100);
    };
    const target = (n) => {
        const rel = n.replace(/^\.\//, '').replace(/\/$/, '');
        if (rel === prefix) return dest;
        if (rel.indexOf(prefix + '/') !== 0) throw new Error('entry outside the archive\'s folder: ' + n);
        const sub = rel.slice(prefix.length + 1);
        if (sub.split('/').some((x) => x === '..' || x === '' || x === '.')) throw new Error('bad entry: ' + n);
        return path.join(dest, sub);
    };

    const step = () => {
        for (;;) {
            if (cur) {
                if (!buf.length) return;
                const take = Math.min(cur.left, buf.length);
                if (take) {
                    if (cur.fd !== undefined) fs.writeSync(cur.fd, buf, 0, take);
                    else cur.data.push(Buffer.from(buf.slice(0, take)));
                    cur.left -= take;
                    buf = buf.slice(take);
                }
                if (cur.left) return;
                if (buf.length < cur.pad) return;
                buf = buf.slice(cur.pad);
                if (cur.fd !== undefined) { fs.closeSync(cur.fd); files++; }
                else {
                    const s = Buffer.concat(cur.data).toString('utf8').replace(/\0.*$/, '');
                    if (cur.kind === 'L') longName = s; else longLink = s;
                }
                cur = null;
                continue;
            }
            if (buf.length < 512) return;
            const h = buf.slice(0, 512);
            buf = buf.slice(512);
            if (h.every((b) => b === 0)) { ended = true; return; }
            const size = parseInt(field(h, 124, 136).trim() || '0', 8);
            const mode = parseInt(field(h, 100, 108).trim() || '644', 8) & 0o777;
            const type = String.fromCharCode(h[156] || 48);
            const pad = (512 - (size % 512)) % 512;
            if (type === 'L' || type === 'K') { cur = { data: [], left: size, pad: pad, kind: type }; continue; }
            const n = longName || name(h);
            const ln = longLink || field(h, 157, 257);
            longName = longLink = null;
            const t = target(n);
            if (type === '5') { mkdirp(t, 0o755); fs.chmodSync(t, mode | 0o700); continue; }
            if (type === '2') {
                if (!ln || ln.indexOf('\0') >= 0) throw new Error('bad link: ' + n);
                mkdirp(path.dirname(t), 0o755);
                links.push([ln, t]);
                continue;
            }
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
            try { step(); } catch (e) { if (cur && cur.fd !== undefined) { try { fs.closeSync(cur.fd); } catch (x) { /* */ } } fail(e); }
        })
        .on('end', () => {
            if (failed) return;
            if (cur) return fail(new Error('archive ends inside an entry'));
            try {
                /* the links last: every file is in place, none was written through a link */
                links.forEach((l) => fs.symlinkSync(l[0], l[1]));
            } catch (e) { return fail(e); }
            cb(null, { files: files, links: links.length });
        });
}

/* archive unpacked at dest, if it isn't already: cb(err, { unpacked, files, sha }).
 * opts.keep: unpack only when dest is missing (the prefix: saves live in it). */
function ensure(archive, dest, log, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    sha256File(archive, (err, sha) => {
        if (err) return cb(err);
        let stamp = '';
        try { stamp = fs.readFileSync(path.join(dest, '.stamp'), 'utf8').trim(); } catch (e) { /* none */ }
        if (stamp === sha) return cb(null, { unpacked: false, sha: sha });
        if (opts.keep && fs.existsSync(dest)) return cb(null, { unpacked: false, sha: sha, kept: stamp || 'unknown' });
        log('bundle: unpacking ' + path.basename(archive) + ' (' + sha.slice(0, 12) + ') into ' + dest);
        const tmp = dest + '.new', old = dest + '.old';
        rmrf(tmp);
        const t0 = Date.now();
        extract(archive, dest.replace(/^\//, ''), tmp, (e2, r) => {
            if (e2) { try { rmrf(tmp); } catch (x) { /* */ } return cb(e2); }
            try {
                fs.writeFileSync(path.join(tmp, '.stamp'), sha + '\n');
                rmrf(old);
                if (fs.existsSync(dest)) fs.renameSync(dest, old);
                fs.renameSync(tmp, dest);
                rmrf(old);
            } catch (e3) { return cb(e3); }
            log('bundle: ' + path.basename(archive) + ': ' + r.files + ' files, ' + r.links + ' links in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
            cb(null, { unpacked: true, files: r.files, links: r.links, sha: sha });
        });
    });
}

module.exports = { ensure, extract, rmrf, mkdirp, chownR };

if (require.main === module) {
    ensure(process.argv[2], process.argv[3], console.log, (err, r) => {
        if (err) { console.error('unpack: ' + err.message); process.exit(1); }
        console.log(JSON.stringify(r));
    });
}
