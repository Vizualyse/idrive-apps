// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The control socket for the vizualyse_moonlight iDrive app:
 * /dev/shm/vizualyse-moonlight/ctl.sock, a Unix stream socket, mode 0660, group
 * tm_oap_app (the group of the renderers' sockets, which apps already use),
 * newline-delimited JSON. Every client gets {"ev":"status", ...} on connect,
 * after each command and once a second. Commands: {"cmd":"enable"},
 * {"cmd":"disable"}, {"cmd":"stop"} (the stream; the game keeps running on
 * the PC), {"cmd":"quit"} (stop and close the game), {"cmd":"resume"} (the
 * last host and game again); anything else, or a command that can't run, is
 * answered with {"ev":"error","error":...}. Who may connect: see TODO.md,
 * "Control-socket hardening" (the same as Cast's for now).
 */
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');

const PATH = process.env.MOONLIGHT_CTL_SOCKET || '/dev/shm/vizualyse-moonlight/ctl.sock';
const GROUP_FROM = ['/dev/shm/cluster-render/render.sock', '/run/mgu-render/render.sock', '/run/mgu-renderd/renderd.sock'];
const MAX_LINE = 4096;

function appGroup() {
    for (const p of GROUP_FROM) { try { return fs.statSync(p).gid; } catch (e) { /* next */ } }
    return null;
}

/* opts: { status() -> object, command(cmd) -> error string or null, log } */
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
                broadcast();
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
    server.listen(PATH, () => {
        if (unixPath) {
            const gid = appGroup();
            try {
                fs.chmodSync(PATH, 0o660);
                if (gid !== null) fs.chownSync(PATH, 0, gid);
            } catch (e) { opts.log('control: ' + e.message); }
            opts.log('control: listening on ' + PATH + (gid !== null ? ' (group ' + gid + ')' : ''));
        } else {
            opts.log('control: listening on ' + PATH);
        }
    });
    const timer = setInterval(broadcast, 1000);

    return {
        broadcast: broadcast,
        close() {
            clearInterval(timer);
            clients.forEach((s) => s.destroy());
            server.close();
            if (unixPath) { try { fs.unlinkSync(PATH); } catch (e) { /* gone */ } }
        },
    };
}

module.exports = { startControl, PATH };
