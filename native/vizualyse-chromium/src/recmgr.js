// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan; the check after mgu-store's
// deploy/unit/mgu-deploy.js (recmgrLoaded, GPL-3.0, Robert Nisipeanu)
/**
 * Whether a systemd unit may be stopped on this head unit without recmgr
 * restarting the whole unit (knowledge/head-unit.md): its name must be in
 * both [Whitelist] and [WhitelistExitSuccess] of /etc/recmgr.ini now, and
 * recmgr must have loaded it, which it does only at boot. So the list as
 * it stood at boot decides: the file itself while it predates the boot,
 * else the copy mgu-deploy saved before this boot's first change
 * (/var/opt/mgu-deploy/recmgr-at-boot.json, { boot, text }). With neither,
 * nothing counts as loaded. Without /etc/recmgr.ini there is no recmgr.
 */
'use strict';

const fs = require('fs');

const INI = process.env.CHROMIUM_RECMGR_INI || '/etc/recmgr.ini';
const AT_BOOT = process.env.CHROMIUM_RECMGR_AT_BOOT || '/var/opt/mgu-deploy/recmgr-at-boot.json';
const BOOT_ID = '/proc/sys/kernel/random/boot_id';

function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

function sections(text) {
    const out = {};
    let cur = null;
    String(text || '').split('\n').forEach((line) => {
        const s = line.split('#')[0].trim();
        const m = /^\[(.*)\]$/.exec(s);
        if (m) { cur = m[1]; if (!out[cur]) out[cur] = []; return; }
        if (cur && s) out[cur].push(s);
    });
    return out;
}

function has(name, text) {
    const s = sections(text);
    return (s.Whitelist || []).indexOf(name) >= 0 && (s.WhitelistExitSuccess || []).indexOf(name) >= 0;
}

function bootId() { const b = read(BOOT_ID); return b ? b.trim() : null; }

function bootTime() {
    const m = /^btime (\d+)$/m.exec(read('/proc/stat') || '');
    return m ? Number(m[1]) : null;
}

function predatesBoot() {
    const bt = bootTime();
    if (bt === null) return false;
    try { return Math.floor(fs.statSync(INI).mtime.getTime() / 1000) < bt; } catch (e) { return false; }
}

/* name: the unit's name without ".service" */
function loaded(name) {
    const text = read(INI);
    if (text === null) return true;
    if (!has(name, text)) return false;
    let at = null;
    try { at = JSON.parse(read(AT_BOOT) || 'null'); } catch (e) { at = null; }
    if (at && at.boot === bootId() && typeof at.text === 'string') return has(name, at.text);
    return predatesBoot();
}

module.exports = { loaded, has, sections };
