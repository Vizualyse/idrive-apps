// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * mqtt_bus.js against the real broker (native/vizualyse-bus: Mosquitto as
 * built for the unit, with its own mosquitto.conf), on Node 8 in the unit's
 * root filesystem (native/vizualyse-bus/test/run_test.sh). Root, as the tools.
 *
 *   MOSQUITTO=/path/mosquitto MOSQUITTO_CONF=/path/mosquitto.conf node mqtt_bus_test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Bus, SOCKET } = require('../mqtt_bus.js');

const MOSQUITTO = process.env.MOSQUITTO, CONF = process.env.MOSQUITTO_CONF;
const DIR = path.dirname(SOCKET);
let failed = 0;
function ok(what, cond, more) {
    console.log((cond ? '  ok   ' : '  FAIL ') + what + (more ? ' (' + more + ')' : ''));
    if (!cond) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms) {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (check()) return true;
    return check();
}

let broker = null, brokerLog = '';
function startBroker() {
    /* as systemd's RuntimeDirectory makes it: root's, 0700 */
    try { fs.mkdirSync(DIR, 0o700); } catch (e) { /* there */ }
    fs.chmodSync(DIR, 0o700);
    broker = spawn(MOSQUITTO, ['-c', CONF], { stdio: ['ignore', 'pipe', 'pipe'] });
    broker.stderr.on('data', (d) => { brokerLog += d; });
    broker.stdout.on('data', (d) => { brokerLog += d; });
    return until(() => fs.existsSync(SOCKET), 5000);
}
function stopBroker(sig) {
    const b = broker;
    broker = null;
    return new Promise((r) => { b.on('exit', r); b.kill(sig || 'SIGTERM'); });
}

async function main() {
    const lines = [];
    const log = (s) => lines.push(s);

    /* 1. no broker yet: nothing breaks, the ask waits */
    try { fs.unlinkSync(SOCKET); } catch (e) { /* none */ }
    const steam = new Bus('vizualyse-steam', { log });
    steam.ask({ 'cluster-video': 'off', 'hud-video': 'off' }, 'a game is running');
    await sleep(300);
    ok('without the broker: no connection, no error, the ask kept', !steam.connected && steam.mine && steam.mine.ask['cluster-video'] === 'off',
        lines.filter((l) => /not there/.test(l))[0]);

    /* 2. the broker comes: the waiting ask goes out */
    ok('the broker starts on its socket (Mosquitto as built for the unit)', await startBroker(), brokerLog.trim().split('\n')[0]);
    ok('the asking tool connects within its retry', await until(() => steam.connected, 7000));

    /* 3. a tool that starts later gets the live ask at once (retained) */
    const cast = new Bus('vizualyse-cast', { log });
    let events = 0;
    cast.on('asks', () => events++);
    ok('a tool that starts later sees the ask (retained)', await until(() => cast.asked('cluster-video', 'off').length === 1, 3000),
        JSON.stringify(cast.asked('cluster-video', 'off')));
    ok('with who asks, and why', (cast.asked('hud-video', 'off')[0] || {}).from === 'vizualyse-steam' && cast.asked('hud-video', 'off')[0].why === 'a game is running');
    ok('a tool never sees its own ask', steam.asked('cluster-video', 'off').length === 0);

    /* 4. cleared */
    steam.ask(null);
    ok('ask(null) clears it for the others', await until(() => cast.asked('cluster-video', 'off').length === 0, 3000));
    ok('each change is one event', events === 2, events + ' events');

    /* 5. a tool that dies takes its asks with it (the broker's will) */
    const child = spawn(process.execPath, ['-e',
        'const { Bus } = require(' + JSON.stringify(path.join(__dirname, '..', 'mqtt_bus.js')) + ');' +
        'const b = new Bus("vizualyse-moonlight"); b.on("connected", () => { b.ask({ "hud-video": "off" }, "streaming"); console.log("asked"); });'],
        { stdio: ['ignore', 'pipe', 'inherit'] });
    ok('another process asks', await until(() => cast.asked('hud-video', 'off').length === 1, 5000));
    child.kill('SIGKILL');
    ok('killed (SIGKILL): its ask goes (its last will)', await until(() => cast.asked('hud-video', 'off').length === 0, 5000));

    /* 6. the broker restarts: everyone's asks hold off while it is away, then come back */
    steam.ask({ 'cluster-video': 'off' }, 'a game is running');
    await until(() => cast.asked('cluster-video', 'off').length === 1, 3000);
    const at0 = cast.asked('cluster-video', 'off')[0].at;
    ok('an ask says when it was made', !!at0 && Math.abs(Date.now() - Date.parse(at0)) < 5000, at0);
    await stopBroker('SIGKILL');
    ok('the broker gone: no ask holds (each tool works alone)', await until(() => cast.asked('cluster-video', 'off').length === 0 && !cast.connected, 3000));
    await startBroker();
    ok('the broker back: both reconnect and the ask is there again (sent again by its tool)',
        await until(() => steam.connected && cast.connected && cast.asked('cluster-video', 'off').length === 1, 9000));
    ok('sent again, it keeps when it was made (the newer start wins across reconnections)', (cast.asked('cluster-video', 'off')[0] || {}).at === at0);

    /* 7. a clean close clears its ask */
    steam.close();
    ok('close() clears its ask', await until(() => cast.asked('cluster-video', 'off').length === 0, 3000));

    /* 8. only root reaches it: the folder is root's and 0700 */
    let denied;
    try {
        denied = execFileSync(process.execPath, ['-e', 'require("net").connect(' + JSON.stringify(SOCKET) + ')' +
            '.on("error", (e) => { console.log(e.code); process.exit(0); }).on("connect", () => { console.log("connected"); process.exit(0); })'],
            { uid: 65534, gid: 65534, encoding: 'utf8' }).trim();
    } catch (e) { denied = 'spawn: ' + e.message; }
    ok('another user can\'t reach the bus', denied === 'EACCES', denied);
    /* LISTEN (0A) sockets in this (test) network namespace: none of the broker's */
    const listening = ['/proc/net/tcp', '/proc/net/tcp6'].map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } })
        .join('\n').split('\n').filter((l) => / 0A /.test(l)).length;
    ok('no TCP listener: the broker listens on its socket only', listening === 0 && fs.statSync(SOCKET).isSocket(),
        listening + ' TCP listeners; ' + brokerLog.split('\n').filter((l) => /listen/i.test(l)).join(' | '));

    cast.close();
    await stopBroker();
    if (failed || process.env.VERBOSE) console.log('---- the clients\' log ----\n' + lines.join('\n') + '\n---- the broker\'s log ----\n' + brokerLog);
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.log('  FAIL ' + e.stack); if (broker) broker.kill('SIGKILL'); process.exit(1); });
