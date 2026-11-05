// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool's firewall rules, at the top of the head unit's nftables `ip
 * filter input` chain (which otherwise ends in a drop), in memory only:
 * - the phone page's TCP port from the uplink's Wi-Fi interface, while on
 *   (comment "vizualyse-moonlight");
 * - while streaming, UDP from the host being streamed (video 47998, control
 *   47999, audio 48000), in case the chain doesn't let replies to the core's
 *   own pings back in (comment "vizualyse-moonlight-host").
 * server.js adds and removes them; the tool's deactivate removes all.
 *
 *   node firewall.js add|remove|show [port] [interface]
 */
'use strict';

const { execFileSync } = require('child_process');

const NFT = process.env.MOONLIGHT_NFT || '/usr/sbin/nft';
const PAGE = 'vizualyse-moonlight';
const HOST = 'vizualyse-moonlight-host';

function handles(comment) {
    let out = '';
    try { out = execFileSync(NFT, ['-a', 'list', 'chain', 'ip', 'filter', 'input'], { encoding: 'utf8' }); } catch (e) { return []; }
    const want = comment ? [comment] : [PAGE, HOST];
    return out.split('\n').filter((l) => want.some((c) => l.indexOf('comment "' + c + '"') >= 0))
        .map((l) => { const m = /# handle (\d+)/.exec(l); return m ? m[1] : null; }).filter(Boolean);
}

function drop(comment) {
    const hs = handles(comment);
    hs.forEach((h) => execFileSync(NFT, ['delete', 'rule', 'ip', 'filter', 'input', 'handle', h]));
    return hs.length;
}

/* Every rule of the tool. */
function remove() { return drop(null); }

function add(port, ifname) {
    drop(PAGE);
    execFileSync(NFT, ['insert', 'rule', 'ip', 'filter', 'input', 'iifname', ifname, 'tcp', 'dport', String(port),
        'accept', 'comment', '"' + PAGE + '"']);
    return handles(PAGE).length;
}

/* UDP from the host (an IPv4 address), or none with null. */
function host(ip) {
    drop(HOST);
    if (!ip) return 0;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('not an IPv4 address: ' + ip);
    execFileSync(NFT, ['insert', 'rule', 'ip', 'filter', 'input', 'ip', 'saddr', ip, 'udp', 'sport', '{ 47998, 47999, 48000 }',
        'accept', 'comment', '"' + HOST + '"']);
    return handles(HOST).length;
}

module.exports = { add: add, remove: remove, host: host, handles: handles };

if (require.main === module) {
    const cmd = process.argv[2], port = Number(process.argv[3]) || 8490, ifname = process.argv[4] || 'wlan0';
    if (cmd === 'add') console.log('firewall: ' + add(port, ifname) + ' rule for ' + ifname + ' tcp ' + port);
    else if (cmd === 'remove') console.log('firewall: removed ' + remove() + ' rule(s)');
    else if (cmd === 'show') console.log('firewall: ' + handles().length + ' rule(s), handles ' + handles().join(' '));
    else { console.error('usage: node firewall.js add|remove|show [port] [interface]'); process.exit(2); }
}
