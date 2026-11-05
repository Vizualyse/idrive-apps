// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * End to end off the car, against a real Sunshine (test/sunshine, on Xvfb
 * with software x264), in the head unit in a box (test/unit: Ubuntu 18.04,
 * Node 8.16.2): moonlight-core's certificate, PIN pairing through
 * gamestream.js (the PIN typed into Sunshine's web API, as a person would on
 * its PIN page), the pinned certificate, the app list, a launch, a stream
 * through moonlight-core decoding into an mgu-render frame file (the GPU's
 * code on the unit's software Media SDK, test/firmware; the resumed stream
 * with the built-in FFmpeg, scaled to the cluster's size at 15 fps), audio
 * decoded, and quit. Run by test/run_sunshine_test.sh:
 *
 *   node test/sunshine_test.js <sunshine address>
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { GameStream } = require('../src/gamestream.js');
const sunshine = require('./sunshine_web.js');

const HOST = process.argv[2];
const HERE = path.join(__dirname, '..');
const CORE = path.join(HERE, 'build', 'moonlight-core');
const { frameFile } = require('../src/console_out.js');
const W = 1280, H = 720, FPS = 30;
/* the unit's software Media SDK when the runner found it (test/firmware), else the built-in FFmpeg */
const MSDK = process.env.MOONLIGHT_TEST_MSDK === '1';

let failed = 0;
const ok = (what, cond, more) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : '')); if (!cond) failed++; };

/* The frame file's header and its newest picture. */
function readFrameFile(file) {
    const b = fs.readFileSync(file);
    const w = b.readUInt32LE(8), h = b.readUInt32LE(12), slot = b.readUInt32LE(20), size = w * h * 3 / 2;
    return { magic: b.readUInt32LE(0), w: w, h: h, seq: b.readUInt32LE(16), matrix: b.readUInt32LE(28), range: b.readUInt32LE(32),
        pic: b.slice(64 + slot * size, 64 + (slot + 1) * size) };
}

/* opts: { decoder, w, h (the frame file's), outFps } */
function stream(launch, info, seconds, opts) {
    return new Promise((resolve) => {
        const file = path.join(os.tmpdir(), 'ml-frames-' + process.pid);
        frameFile(file, opts.w, opts.h);
        const args = ['stream', '--address', HOST, '--appversion', info.appversion, '--gfeversion', info.gfeversion,
            '--rtsp', launch.rtsp || '', '--codecs', String(info.codecs), '--width', String(W), '--height', String(H),
            '--fps', String(FPS), '--bitrate', '6000', '--rikey', launch.rikey, '--rikeyid', String(launch.rikeyid), '--no-pads',
            '--frame-file', file, '--decoder', opts.decoder, '--bt709'].concat(opts.outFps ? ['--out-fps', String(opts.outFps)] : []);
        const core = spawn(CORE, args, { stdio: ['pipe', 'ignore', 'pipe', 'pipe'] });
        const r = { events: [], pcm: 0, log: [] };
        core.stdio[3].on('data', (d) => { r.pcm += d.length; });
        let buf = '';
        core.stderr.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const l = buf.slice(0, i); buf = buf.slice(i + 1);
                if (l[0] === '@') { try { r.events.push(JSON.parse(l.slice(1))); } catch (e) { r.log.push('bad event ' + l); } } else r.log.push(l);
            }
        });
        setTimeout(() => core.stdin.write('phonepad 4096 0 0 0 0 0 0\nphonepad 0 0 0 0 0 0 0\n'), 3000);
        setTimeout(() => core.stdin.write('quit\n'), seconds * 1000);
        core.on('exit', (code) => {
            r.code = code;
            r.file = readFrameFile(file);
            fs.unlinkSync(file);
            const st = r.events.filter((e) => e.ev === 'stopped')[0];
            r.pictures = st ? st.pictures : 0;
            resolve(r);
        });
    });
}

async function main() {
    if (!HOST) { console.error('usage: node test/sunshine_test.js <address>'); process.exit(2); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-id-'));
    execFileSync(CORE, ['gencert', path.join(dir, 'cert.pem'), path.join(dir, 'key.pem')]);
    const id = { uniqueId: crypto.randomBytes(8).toString('hex').toUpperCase(),
        cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8') };
    ok('gencert: a certificate and an RSA key', /BEGIN CERTIFICATE/.test(id.cert) && /PRIVATE KEY/.test(id.key));
    ok('gencert: the key is private', (fs.statSync(path.join(dir, 'key.pem')).mode & 0o077) === 0);

    const host = { address: HOST };
    const gs = new GameStream(id, host, { log: (s) => console.log('     ' + s) });
    let info = await gs.serverInfo();
    ok('serverinfo over HTTP: not paired yet', !info.paired, info.name + ' ' + info.appversion);

    /* a wrong PIN is refused and leaves nothing paired */
    const wrong = gs.pair('1111', 20000).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 1500));
    await sunshine.typePin(HOST, '2222');
    let err = await wrong;
    ok('a wrong PIN is refused', err && /wrong PIN|refused/.test(err.message), err && err.message);
    host.serverCert = undefined;

    const pin = String(1000 + crypto.randomBytes(2).readUInt16BE(0) % 9000);
    const pairing = gs.pair(pin, 20000);
    await new Promise((r) => setTimeout(r, 1500));
    const typed = await sunshine.typePin(HOST, pin);
    let cert = null;
    try { cert = await pairing; } catch (e) { err = e; }
    ok('pairing with the PIN typed on the host', !!cert, cert ? 'pin ' + pin + ', host said ' + typed : err && err.message);
    if (!cert) return;

    info = await gs.serverInfo();
    ok('serverinfo over HTTPS (the pinned certificate): paired', info.paired && info.secure);

    const apps = await gs.appList();
    ok('the app list', apps.length >= 1, apps.map((a) => a.id + ' ' + a.name).join(', '));
    const app = apps.find((a) => a.name === 'Desktop') || apps[0];

    const other = new GameStream(id, { address: HOST, serverCert: id.cert }, {});
    err = null;
    try { await other.appList(); } catch (e) { err = e; }
    ok('another certificate than the pinned one is refused', err && /certificate changed/.test(err.message), err && err.message);

    const launch = await gs.launch(app.id, { width: W, height: H, fps: FPS, sops: false, localAudio: false, gamepadMask: 1 });
    ok('launch: an RTSP session', !!launch.rtsp, launch.rtsp + ' rikeyid ' + launch.rikeyid);

    const r = await stream(launch, info, 10, { decoder: MSDK ? 'msdk-sw' : 'av', w: W, h: H });
    const ev = (n) => r.events.filter((e) => e.ev === n);
    const stats = ev('stats');
    ok('moonlight-core: connection started', ev('started').length === 1, ev('stage-failed').map((e) => e.stage + ' ' + e.code + ' ' + e.ports).join('; '));
    ok('moonlight-core: H.264 at the asked size', ev('video').some((e) => e.width === W && e.height === H));
    ok('moonlight-core: decoded with the ' + (MSDK ? 'Media SDK' : 'built-in FFmpeg'), ev('decoder').some((e) => (MSDK ? /^msdk \(software/ : /^av /).test(e.name)),
        JSON.stringify(ev('decoder')[0] || {}));
    ok('the pictures go into the frame file', r.pictures >= FPS * 3 && r.file.seq === r.pictures && r.file.w === W && r.file.h === H,
        r.pictures + ' pictures, seq ' + r.file.seq);
    ok('the frame file says BT.709, limited range, as asked of the PC', r.file.matrix === 1 && r.file.range === 0);
    ok('a picture with something in it', r.file.pic.some((v) => v !== 0));
    ok('moonlight-core: stats each second', stats.length >= 5, stats.map((e) => e.fps + '/' + e.pps + ' ' + e.decodeMs + 'ms').join(' '));
    ok('no frame failed to decode', stats.length && stats[stats.length - 1].failed === 0);
    ok('the audio stream opens', ev('audio').some((e) => e.ok && e.channels === 2), JSON.stringify(ev('audio')[0] || {}) + ', ' + r.pcm + ' bytes of PCM');
    ok('the phone pad arrives as a controller', ev('pad').some((e) => e.name === 'Phone' && e.present));
    ok('quit stops it cleanly', r.code === 0 && ev('stopped').length === 1, 'exit ' + r.code);
    if (failed) console.log(r.log.slice(-25).join('\n'));

    info = await gs.serverInfo();
    ok('the game is still running after a stop', info.currentGame === app.id, 'currentgame ' + info.currentGame);
    const resume = await gs.launch(app.id, { width: W, height: H, fps: FPS, resume: true, gamepadMask: 1 });
    ok('resume: a new session for the running game', !!resume.rtsp);
    const r2 = await stream(resume, info, 5, { decoder: 'av', w: 640, h: 360, outFps: 15 });
    const ev2 = (n) => r2.events.filter((e) => e.ev === n);
    ok('the resumed session streams, decoded by the built-in FFmpeg', r2.pictures >= 15 && ev2('decoder').some((e) => /^av /.test(e.name)),
        r2.pictures + ' pictures, ' + (ev2('decoder')[0] || {}).name);
    const s2 = ev2('stats');
    ok('scaled to the cluster\'s 640x360, at most 15 pictures a second', r2.file.w === 640 && s2.length && s2.every((e) => e.pps <= 16),
        s2.map((e) => e.fps + '/' + e.pps).join(' '));
    await gs.quit();
    info = await gs.serverInfo();
    ok('quit closes the game on the host', info.currentGame === 0);

    console.log(failed ? failed + ' failed' : 'all Sunshine tests passed');
}

main().then(() => process.exit(failed ? 1 : 0), (e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
