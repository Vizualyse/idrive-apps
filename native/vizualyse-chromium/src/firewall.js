// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool's firewall rule, at the top of the head unit's nftables `ip filter
 * input` chain (which otherwise ends in a drop), in memory only: the phone
 * page's TCP port from the uplink's Wi-Fi interface, while the browser is on
 * (comment "vizualyse-chromium"). server.js adds and removes it; the tool's
 * deactivate removes it. (As vizualyse-moonlight's.)
 *
 *   node firewall.js add|remove|show [port] [interface]
 */
'use strict';

const { execFileSync } = require('child_process');

const NFT = process.env.CHROMIUM_NFT || '/usr/sbin/nft';
const PAGE = 'vizualyse-chromium';

function handles() {
    let out = '';
    try { out = execFileSync(NFT, ['-a', 'list', 'chain', 'ip', 'filter', 'input'], { encoding: 'utf8' }); } catch (e) { return []; }
    return out.split('\n').filter((l) => l.indexOf('comment "' + PAGE + '"') >= 0)
        .map((l) => { const m = /# handle (\d+)/.exec(l); return m ? m[1] : null; }).filter(Boolean);
}

function remove() {
    const hs = handles();
    hs.forEach((h) => execFileSync(NFT, ['delete', 'rule', 'ip', 'filter', 'input', 'handle', h]));
    return hs.length;
}

function add(port, ifname) {
    remove();
    execFileSync(NFT, ['insert', 'rule', 'ip', 'filter', 'input', 'iifname', ifname, 'tcp', 'dport', String(port),
        'accept', 'comment', '"' + PAGE + '"']);
    return handles().length;
}

module.exports = { add: add, remove: remove, handles: handles };

if (require.main === module) {
    const cmd = process.argv[2], port = Number(process.argv[3]) || 8491, ifname = process.argv[4] || 'wlan0';
    if (cmd === 'add') console.log('firewall: ' + add(port, ifname) + ' rule for ' + ifname + ' tcp ' + port);
    else if (cmd === 'remove') console.log('firewall: removed ' + remove() + ' rule(s)');
    else if (cmd === 'show') console.log('firewall: ' + handles().length + ' rule(s), handles ' + handles().join(' '));
    else { console.error('usage: node firewall.js add|remove|show [port] [interface]'); process.exit(2); }
}
