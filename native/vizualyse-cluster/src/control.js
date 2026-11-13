// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The control socket for the vizualyse_cluster iDrive app:
 * /dev/shm/vizualyse-cluster/ctl.sock, a Unix stream socket, mode 0660, in the group of
 * the vizualyse_cluster app alone (appGid below; root only until it is installed),
 * newline-delimited JSON. Every client gets {"ev":"status", ...} on connect,
 * after each command and once a second. Commands: {"cmd":"enable"} /
 * {"cmd":"disable"} (the theme on the cluster or not), {"cmd":"theme","id":..},
 * {"cmd":"source","source":"car"|"demo"}, {"cmd":"signals", name: value ...}
 * (the car's readings, as often as the app reads them) and
 * {"cmd":"speed","kmh":N} (about once a second); those two are answered
 * with nothing. Anything else, or a command that can't run, is answered with
 * {"ev":"error","error":...}. (Copied from vizualyse-steam's.)
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const PATH = process.env.CLUSTER_CTL_SOCKET || '/dev/shm/vizualyse-cluster/ctl.sock';
const OAP_DIR = process.env.CTL_OAP_DIR || '/var/opt/public/oap';
const MAX_LINE = 4096;
const RECHECK_MS = 10000;

/* Who may connect: only the tool's own iDrive app. Every Store app runs as
 * its own uid, with that uid as its primary group, installed under
 * OAP_DIR/oap_<uid>/source; all of them share the group tm_oap_app, so a
 * socket in that group is open to every app (found on the car, 2026-11-05).
 * The socket gets the app's own group instead, found by its package name:
 * the gid, or null while the app is not installed. */
function appGid(appName) {
    let dirs = [];
    try { dirs = fs.readdirSync(OAP_DIR).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (const d of dirs) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(OAP_DIR, d, 'source', 'package.json'), 'utf8'));
            if (pkg.name === appName) return fs.statSync(path.join(OAP_DIR, d)).gid;
        } catch (e) { /* not an app, or unreadable */ }
    }
    return null;
}

/* opts: { app (the iDrive app's package name), status() -> object,
 * command(cmd) -> error string or null, log } */
function startControl(opts) {
    const clients = new Set();
    const send = (sock, obj) => { try { sock.write(JSON.stringify(obj) + '\n'); } catch (e) { /* gone */ } };
    const broadcast = () => {
        if (!clients.size) return;
        const st = Object.assign({ ev: 'status' }, opts.status());
        clients.forEach((s) => send(s, st));
    };

    const server = net.createServer((sock) => {
        clients.add(sock);
        sock.setEncoding('utf8');
        let buf = '';
        sock.on('data', (d) => {
            buf += d;
            if (buf.length > MAX_LINE) { sock.destroy(); return; }
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let cmd = null;
                try { cmd = JSON.parse(line); } catch (e) { send(sock, { ev: 'error', error: 'bad JSON' }); continue; }
                const err = opts.command(cmd || {});
                if (err) send(sock, { ev: 'error', error: err });
                /* the speed and the signals come all the time: the status goes out once a second anyway */
                if (err || !cmd || (cmd.cmd !== 'speed' && cmd.cmd !== 'signals')) broadcast();
            }
        });
        sock.on('error', () => { /* close follows */ });
        sock.on('close', () => clients.delete(sock));
        send(sock, Object.assign({ ev: 'status' }, opts.status()));
    });

    const unixPath = PATH.indexOf('\\\\') !== 0 && PATH.indexOf('//') !== 0;
    if (unixPath) {
        const dir = path.dirname(PATH);
        try { fs.mkdirSync(dir, 0o755); } catch (e) { /* there */ }
        try { fs.chmodSync(dir, 0o755); } catch (e) { /* not ours */ }
        try { fs.unlinkSync(PATH); } catch (e) { /* none */ }
    }
    server.on('error', (e) => opts.log('control: ' + e.message));
    /* The socket's group: the app's (0660), or root only (0600) while the app
     * is not installed; looked up again every RECHECK_MS (an app reinstalled
     * can get a new uid). */
    let gid;
    const secure = () => {
        if (!unixPath) return;
        const g = appGid(opts.app);
        if (g === gid) return;
        gid = g;
        try {
            if (g === null) { fs.chmodSync(PATH, 0o600); fs.chownSync(PATH, 0, 0); }
            else { fs.chownSync(PATH, 0, g); fs.chmodSync(PATH, 0o660); }
        } catch (e) { opts.log('control: ' + e.message); }
        opts.log('control: ' + PATH + (g === null ? ' root only (' + opts.app + ' is not installed)' : ' for ' + opts.app + ' (group ' + g + ')'));
    };
    server.listen(PATH, () => {
        if (unixPath) {
            /* root only first, then the app's group */
            try { fs.chmodSync(PATH, 0o600); } catch (e) { opts.log('control: ' + e.message); }
            secure();
        }
        opts.log('control: listening on ' + PATH);
    });
    const timer = setInterval(broadcast, 1000);
    const recheck = setInterval(secure, RECHECK_MS);

    return {
        broadcast: broadcast,
        close() {
            clearInterval(timer);
            clearInterval(recheck);
            clients.forEach((s) => s.destroy());
            server.close();
            if (unixPath) { try { fs.unlinkSync(PATH); } catch (e) { /* gone */ } }
        },
    };
}

module.exports = { startControl, PATH };
