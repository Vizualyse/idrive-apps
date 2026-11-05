// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Who may connect to a tool's control socket (src/control.js), as root in a
 * Linux container: a fake Store (CTL_OAP_DIR) with the tool's app and another
 * app, each its own uid and group, both in tm_oap_app as on the car. The
 * app connects; the other app is refused; with the app gone the socket is
 * root only; reinstalled with a new uid, the new uid connects. Used for both
 * tools (their control.js are the same):
 *
 *   node test/control_test.js [path/to/control.js app_name]
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CONTROL = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'control.js'));
const APP = process.argv[3] || 'vizualyse_cast';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
const OAP = path.join(TMP, 'oap');
const SOCK = path.join(TMP, 'ctl.sock');
const GROUP = 12202;   /* tm_oap_app */

let failed = 0;
const ok = (what, cond, more) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : '')); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function install(uid, name) {
    const d = path.join(OAP, 'oap_' + uid);
    fs.mkdirSync(d);
    fs.mkdirSync(path.join(d, 'source'));
    fs.writeFileSync(path.join(d, 'source', 'package.json'), JSON.stringify({ name: name, version: '1.0.0' }));
    fs.chownSync(d, 12201, uid);
    fs.chmodSync(d, 0o750);
}
function uninstall(uid) { spawnSync('rm', ['-rf', path.join(OAP, 'oap_' + uid)]); }

/* Connect as an app: its uid, its own group and tm_oap_app. 'status' or the error code. */
function connectAs(uid) {
    const code = "const net=require('net');process.setgroups([" + GROUP + "," + uid + "]);process.setgid(" + uid + ");process.setuid(" + uid + ");" +
        "const s=net.createConnection(" + JSON.stringify(SOCK) + ");s.setEncoding('utf8');" +
        "s.once('data',(d)=>{console.log(JSON.parse(d.split(String.fromCharCode(10))[0]).ev);process.exit(0)});s.on('error',(e)=>{console.log(e.code);process.exit(0)});";
    /* async: the server answering is in this process */
    return new Promise((resolve) => {
        const c = spawn(process.execPath, ['-e', code]);
        let out = '', err = '';
        c.stdout.on('data', (d) => { out += d; });
        c.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => c.kill(), 5000);
        c.on('exit', () => { clearTimeout(t); resolve(out.trim() || 'no answer: ' + err.trim()); });
    });
}

async function main() {
    if (process.getuid() !== 0) { console.log('control_test needs root (a container)'); process.exit(2); }
    fs.chmodSync(TMP, 0o755);   /* the apps must reach the socket's directory, as /dev/shm/<tool> */
    fs.mkdirSync(OAP);
    process.env.CTL_OAP_DIR = OAP;
    process.env.CAST_CTL_SOCKET = SOCK;
    process.env.MOONLIGHT_CTL_SOCKET = SOCK;
    process.env.CHROMIUM_CTL_SOCKET = SOCK;
    install(12225, APP);
    install(12224, 'doom');
    const logs = [];
    const { startControl } = require(CONTROL);
    const ctl = startControl({ app: APP, status: () => ({ link: 'http://x/?t=secret' }), command: () => null, log: (s) => logs.push(s) });
    await sleep(400);

    let st = fs.statSync(SOCK);
    ok('the socket is the app\'s group, 0660', st.gid === 12225 && (st.mode & 0o777) === 0o660, 'gid ' + st.gid + ' mode ' + (st.mode & 0o777).toString(8));
    ok('the app connects', (await connectAs(12225)) === 'status');
    const other = await connectAs(12224);
    ok('another app (in tm_oap_app) is refused', other === 'EACCES', other);

    uninstall(12225);
    await sleep(10600);
    st = fs.statSync(SOCK);
    ok('the app removed: root only', st.gid === 0 && (st.mode & 0o777) === 0o600, 'gid ' + st.gid + ' mode ' + (st.mode & 0o777).toString(8));
    ok('then not even its old uid connects', (await connectAs(12225)) === 'EACCES');

    install(12230, APP);
    await sleep(10600);
    ok('reinstalled with a new uid: that uid connects', (await connectAs(12230)) === 'status');
    ok('the old uid stays refused', (await connectAs(12225)) === 'EACCES');
    ok('logged', logs.some((l) => /root only/.test(l)) && logs.some((l) => /group 12230/.test(l)), logs.join(' | '));

    ctl.close();
    console.log(failed ? failed + ' failed' : 'all control socket tests passed');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.log('FAIL ' + e.stack); process.exit(1); });
