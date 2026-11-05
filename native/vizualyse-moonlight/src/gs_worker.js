// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * gamestream.js in a child process running as the tool's uplink uid
 * (server.js forks it): mgu-uplink routes only listed uids through wlan0,
 * and root has no route to the PC there (seen on the car). One request a
 * message: { id, op, ident, host, args } -> { id, result } or { id, error },
 * with the host's fields gamestream.js keeps up to date (httpsPort,
 * serverCert).
 */
'use strict';

const { GameStream } = require('./gamestream.js');

process.on('message', (m) => {
    const gs = new GameStream(m.ident, m.host, { log: (s) => process.send({ log: s }) });
    let p;
    try { p = Promise.resolve(gs[m.op].apply(gs, m.args || [])); } catch (e) { p = Promise.reject(e); }
    p.then((r) => process.send({ id: m.id, result: r === undefined ? null : r, host: gs.host }),
        (e) => process.send({ id: m.id, error: (e && e.message) || String(e), host: gs.host }));
});
process.on('disconnect', () => process.exit(0));
