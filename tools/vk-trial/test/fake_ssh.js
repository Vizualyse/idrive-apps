// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// gate_test.sh / anv_test.sh: stands in for the unit's SSH (Node 8, the
// unit's own). Listens on TCP 22 like systemd's sshd.socket, connects to it
// once over loopback like a session, and writes that session's client port
// to /tmp/sshport, so the test can set SSH_CONNECTION as sshd would:
// "127.0.0.1 <port> 127.0.0.1 22". Both stay open until killed.
'use strict';
const net = require('net');
const fs = require('fs');
const keep = [];
const server = net.createServer((s) => keep.push(s));
server.listen(22, '0.0.0.0', () => {
    const c = net.connect(22, '127.0.0.1', () => fs.writeFileSync('/tmp/sshport', String(c.localPort)));
    keep.push(c);
});
