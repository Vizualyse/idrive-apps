// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The uplink proxy: an HTTP proxy on 127.0.0.1 that ffmpeg reaches the
 * internet through. It runs as the tool's internet uid, which mgu-uplink
 * routes through the phone (root is never routed), and resolves names through
 * the uplink's own DNS servers, since the head unit's resolver does not
 * resolve internet names. Plain requests (absolute URIs) are forwarded,
 * CONNECT is tunnelled (HTTPS: TLS stays end to end between ffmpeg and the
 * server).
 *
 *   node proxy.js <port>      (spawned by server.js with the internet uid)
 */
'use strict';

const http = require('http');
const net = require('net');
const dns = require('dns');
const fs = require('fs');
const { URL } = require('url');

const PORT = Number(process.argv[2]) || 8481;
const LEASE = '/run/mgu-uplink/lease.json';
const CACHE_MS = 60000;

const cache = new Map();   /* host -> { ip, at } */

function uplinkDns() {
    try {
        const l = JSON.parse(fs.readFileSync(LEASE, 'utf8'));
        return (l.dns && l.dns.length ? l.dns : [l.router]).filter(Boolean);
    } catch (e) {
        return [];
    }
}

/* The IPv4 address of `host` through the uplink's DNS: cb(err, ip). */
function resolve(host, cb) {
    if (net.isIPv4(host)) return cb(null, host);
    const hit = cache.get(host);
    if (hit && Date.now() - hit.at < CACHE_MS) return cb(null, hit.ip);
    const servers = uplinkDns();
    if (!servers.length) return cb(new Error('no uplink (no DNS server in ' + LEASE + ')'));
    const r = new dns.Resolver();
    r.setServers(servers);
    r.resolve4(host, (err, addrs) => {
        if (err || !addrs || !addrs.length) return cb(err || new Error('no address for ' + host));
        cache.set(host, { ip: addrs[0], at: Date.now() });
        cb(null, addrs[0]);
    });
}

function fail(res, code, why) {
    try { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(why + '\n'); } catch (e) { /* gone */ }
}

const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url); } catch (e) { return fail(res, 400, 'absolute URI required'); }
    if (u.protocol !== 'http:') return fail(res, 400, 'only http:// here; https goes through CONNECT');
    resolve(u.hostname, (err, ip) => {
        if (err) return fail(res, 502, 'dns: ' + err.message);
        const headers = Object.assign({}, req.headers);
        delete headers['proxy-connection'];
        headers.host = u.host;
        const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: headers }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        up.on('error', (e) => fail(res, 502, e.message));
        req.pipe(up);
    });
});

server.on('connect', (req, sock, head) => {
    const m = /^([^:\s]+):(\d+)$/.exec(req.url);
    if (!m) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    resolve(m[1], (err, ip) => {
        if (err) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
        const up = net.connect(Number(m[2]), ip, () => {
            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head && head.length) up.write(head);
            up.pipe(sock);
            sock.pipe(up);
        });
        const close = () => { up.destroy(); sock.destroy(); };
        up.on('error', () => { if (!sock.destroyed) sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); close(); });
        sock.on('error', close);
    });
});

server.on('clientError', (e, sock) => sock.destroy());
server.listen(PORT, '127.0.0.1', () => console.log('proxy: listening on 127.0.0.1:' + PORT + ' as uid ' + process.getuid()));
