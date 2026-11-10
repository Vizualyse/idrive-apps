// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool end to end off the car: server.js in the head unit in a box
 * (test/unit), against a real Sunshine (test/sunshine), driven through the
 * phone page's API and the iDrive app's control socket. The renderer and
 * the speakers are stand-ins (test/fake): moonlight-core decodes into the
 * frame file as on the car (the GPU's code, on the unit's software Media
 * SDK: test/firmware), the audio lands in a file. The car's speed comes as
 * the iDrive app sends it. Virtual gamepads too, each found while
 * idle, announced to the PC while streaming, gone when unplugged: with
 * MOONLIGHT_TEST_PAD an evdev one (test/uinput_pad, needs /dev/uinput), with
 * MOONLIGHT_TEST_USBPAD an XInput USB pad read through usbfs as on the car
 * (test/usbip_pad, needs vhci_hcd); both need the host's /dev. The quit combo
 * is held on the USB pad when there is one. Run by test/run_sunshine_test.sh:
 *
 *   node test/server_test.js <sunshine address>
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const sunshine = require('./sunshine_web.js');

const HOST = process.argv[2];
const HERE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-server-'));
const PORT = 18490;
const SOCK = path.join(TMP, 'ctl.sock');
const VIDEO = path.join(TMP, 'mgu-video');
const PCM = path.join(TMP, 'pcm');
const RENDER_LOG = path.join(TMP, 'render.log');
const TOUCH = path.join(TMP, 'touch');

/* A 2.75 s hold, from the hold captured on the car (test/fixtures: 1.25 s at
 * 1280,274) slowed down: the same PDUs, 2.2 times further apart. */
function holdCapture() {
    const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'id7-touch-capture.txt'), 'utf8').split('\n').filter(Boolean)
        .map((l) => l.split(' ')).filter((f) => +f[0] >= 660 && +f[0] <= 1911);
    return lines.map((f) => Math.round((+f[0] - 660) * 2.2) + ' ' + f.slice(1).join(' ')).join('\n') + '\n';
}
const PAD_KINDS = [
    { env: 'MOONLIGHT_TEST_USBPAD', name: 'Test USB Pad', what: 'a USB (XInput, usbfs) gamepad', node: /^ready \/dev\/bus\/usb\/\d{3}\/\d{3}$/, usb: true },
    { env: 'MOONLIGHT_TEST_PAD', name: 'Test Xbox Pad', what: 'an evdev gamepad', node: /^ready \/dev\/input\/event\d+$/ },
];

let failed = 0;
const ok = (what, cond, more) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : '')); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the tool's files as the kit lays them out, with the stand-ins */
function kit() {
    const k = path.join(TMP, 'kit');
    fs.mkdirSync(k);
    /* as on the car (/var/opt/<tool>/current): readable by the uplink uid */
    fs.chmodSync(TMP, 0o755);
    fs.chmodSync(k, 0o755);
    ['server.js', 'gamestream.js', 'gs_worker.js', 'firewall.js', 'console_out.js', 'cluster_render_client.js', 'control.js', 'page.html', 'pcm_play.py', 'speakers.js']
        .forEach((f) => fs.copyFileSync(path.join(HERE, 'src', f), path.join(k, f)));
    fs.copyFileSync(path.join(HERE, 'build', 'hint.rgba'), path.join(k, 'hint.rgba'));
    fs.copyFileSync(path.join(HERE, 'build', 'moonlight-core'), path.join(k, 'moonlight-core'));
    fs.chmodSync(path.join(k, 'moonlight-core'), 0o755);
    fs.copyFileSync(path.join(__dirname, 'fake', 'python.sh'), path.join(TMP, 'python'));
    fs.chmodSync(path.join(TMP, 'python'), 0o755);
    return k;
}

function req(method, p, body, tok) {
    const data = body ? JSON.stringify(body) : '';
    return new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method,
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, tok ? { 'X-Moonlight-Token': tok } : {}) }, (res) => {
            let b = '';
            res.on('data', (d) => { b += d; });
            res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* text */ } resolve({ code: res.statusCode, body: b, json: j }); });
        });
        r.on('error', reject);
        r.end(data);
    });
}

/* The iDrive app's side: one command, the status that follows it. */
function control(cmd) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection(SOCK);
        let buf = '', sent = false, got = [];
        s.setEncoding('utf8');
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
                got.push(m);
                if (!sent) { sent = true; s.write(JSON.stringify(cmd) + '\n'); } else { s.end(); resolve(got); }
            }
        });
        s.on('error', reject);
    });
}

async function until(tok, what, test, ms) {
    const end = Date.now() + ms;
    let s = null;
    while (Date.now() < end) {
        s = (await req('GET', '/api/status', null, tok)).json;
        if (s && test(s)) return s;
        await sleep(300);
    }
    console.log('     (timed out waiting for ' + what + '; last status: ' + JSON.stringify(s && { state: s.state, error: s.error, frames: s.frames }) + ')');
    return s;
}

function videoSeq() {
    try { const b = fs.readFileSync(VIDEO).slice(0, 24); return { magic: b.readUInt32LE(0), w: b.readUInt32LE(8), h: b.readUInt32LE(12), seq: b.readUInt32LE(16) }; } catch (e) { return null; }
}

async function main() {
    if (!HOST) { console.error('usage: node test/server_test.js <address>'); process.exit(2); }
    const k = kit();
    let pads = [];
    for (const kind of PAD_KINDS) {
        if (!process.env[kind.env]) continue;
        const proc = spawn(process.env[kind.env], ['300'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let err = '';
        proc.stderr.on('data', (d) => { err += String(d); });
        const ready = await new Promise((r) => { proc.stdout.once('data', (d) => r(String(d).trim())); proc.on('exit', (c) => r('exit ' + c)); setTimeout(() => r('not ready in 20 s'), 20000); });
        if (!kind.node.test(ready)) { console.log('skip ' + kind.what + ': ' + ready + ' ' + err.trim()); proc.kill(); continue; }
        console.log('     virtual gamepad: ' + kind.name + ', ' + ready);
        pads.push(Object.assign({ proc: proc, err: () => err }, kind));
    }
    const hasPad = (x, pad) => x && x.pads.some((q) => q.name === pad.name);
    const hasPads = (x) => pads.every((pad) => hasPad(x, pad));
    const padNames = (x) => x.pads.map((q) => q.slot === undefined ? q.name : q.slot + ' ' + q.name).join(', ');
    const env = Object.assign({}, process.env, {
        MOONLIGHT_STATE: path.join(TMP, 'state'), MOONLIGHT_PORT: String(PORT), MOONLIGHT_CTL_SOCKET: SOCK, MOONLIGHT_NO_FIREWALL: '1',
        MOONLIGHT_RENDER_CLIENT: path.join(__dirname, 'fake', 'render_client.js'), MOONLIGHT_VIDEO_FILE: VIDEO,
        MOONLIGHT_PYTHON: path.join(TMP, 'python'), MOONLIGHT_TEST_PCM: PCM, MOONLIGHT_TEST_RENDER_LOG: RENDER_LOG, MOONLIGHT_TOUCH_FILE: TOUCH,
        MOONLIGHT_LINK_IP: '192.0.2.10', MOONLIGHT_DECODER: process.env.MOONLIGHT_TEST_MSDK === '1' ? 'msdk-sw' : 'av', MOONLIGHT_SMALL_DIR: path.join(TMP, 'small'),
    });
    const srv = spawn(process.execPath, [path.join(k, 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    srv.stdout.on('data', (d) => out.push(String(d)));
    srv.stderr.on('data', (d) => out.push(String(d)));
    let tok = null;
    for (let i = 0; i < 60 && !tok; i++) { await sleep(200); try { tok = fs.readFileSync(path.join(TMP, 'state', 'token'), 'utf8').trim(); } catch (e) { /* not yet */ } }
    await sleep(800);
    try {
        ok('no token: refused', (await req('GET', '/', null, null)).code === 403);
        const page = await req('GET', '/', null, tok);
        ok('the phone page', page.code === 200 && /Moonlight on iDrive/.test(page.body));
        let s = (await req('GET', '/api/status', null, tok)).json;
        ok('status: idle, a link, no PCs', s.state === 'idle' && /^http:\/\/192\.0\.2\.10:18490\/\?t=/.test(s.link) && s.hosts.length === 0, s.link);
        ok('the client certificate was made', fs.existsSync(path.join(TMP, 'state', 'identity', 'cert.pem')));
        const key = fs.statSync(path.join(TMP, 'state', 'identity', 'key.pem')).mode & 0o777;
        ok('its key is private', key === 0o600, key.toString(8));
        if (pads.length) s = await until(tok, 'the gamepads found', hasPads, 8000);
        for (const pad of pads) ok(pad.what + ' is found while idle', hasPad(s, pad), padNames(s));

        const bad = await req('POST', '/api/hosts/add', { address: 'a b' }, tok);
        ok('a bad address is refused', bad.code === 400);
        s = (await req('POST', '/api/hosts/add', { address: HOST }, tok)).json;
        const h = s.hosts[0];
        ok('add the PC: online, not paired', s.hosts.length === 1 && h.online && !h.paired, h && h.name);

        s = (await req('POST', '/api/pair', { id: h.id }, tok)).json;
        ok('pair: a 4-digit PIN to type on the PC', s.pairing && /^\d{4}$/.test(s.pairing.pin), s.pairing && s.pairing.pin);
        const typed = await sunshine.typePin(HOST, s.pairing.pin);
        s = await until(tok, 'paired', (x) => x.hosts[0].paired && x.hosts[0].apps, 20000);
        ok('paired, and the games listed', s.hosts[0].paired && (s.hosts[0].apps || []).length >= 1, typed);
        ok('the host\'s certificate is not shown to the page', JSON.stringify(s).indexOf('CERTIFICATE') < 0);
        const app = s.hosts[0].apps.filter((a) => a.name === 'Desktop')[0];

        const o = await req('POST', '/api/output', { output: 'map' }, tok);
        ok('the cluster refused without cluster-render', o.code === 400 && /not available/.test(o.json.error), o.json.error);
        const outs = o.json.status.outputs.map((x) => x.id + (x.ready ? '+' : '-')).join();
        ok('the outputs listed, the centre console chosen', o.json.status.output === 'console' && outs === 'console+,map-,hud-', outs);
        ok('the bitrate on auto at first: 5 Mbps for 720p30', s.settings.bitrateAuto && s.settings.bitrate === 5000, s.settings.bitrate);
        s = (await req('POST', '/api/settings', { mode: '960x540', fps: 60 }, tok)).json;
        ok('auto follows the size and rate: 5 Mbps for 540p60', s.settings.bitrateAuto && s.settings.bitrate === 5000 && s.modes[0] === '960x540', s.settings.bitrate);
        s = (await req('POST', '/api/settings', { fps: 30 }, tok)).json;
        ok('auto: 3 Mbps for 540p30', s.settings.bitrate === 3000, s.settings.bitrate);
        s = (await req('POST', '/api/settings', { mode: '1280x720', fps: 30, bitrate: 6000, audio: true, volume: 50 }, tok)).json;
        ok('stream settings kept, a bitrate set by hand', s.settings.mode === '1280x720' && s.settings.fps === 30 && s.settings.volume === 50 &&
            !s.settings.bitrateAuto && s.settings.bitrate === 6000);
        let st = await control({ cmd: 'output', output: 'map' });
        ok('the iDrive app\'s output: the cluster refused without cluster-render', st.some((m) => m.ev === 'error' && /not available/.test(m.error)));
        st = await control({ cmd: 'output', output: 'console' });
        ok('the iDrive app\'s output: the centre console', !st.some((m) => m.ev === 'error') && st[1].output === 'console');

        const p = await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        ok('play', p.code === 200, p.json && p.json.error);
        s = await until(tok, 'streaming', (x) => x.state === 'streaming' && x.frames > 60, 25000);
        ok('streaming, frames decoded', s.state === 'streaming' && s.frames > 60, s.frames + ' frames, ' + s.fps + ' fps, ' + s.size);
        ok('decoded by moonlight-core, no ffmpeg', (process.env.MOONLIGHT_TEST_MSDK === '1' ? /^msdk \(software/ : /^av /).test(s.decoder || '') && s.decodeMs > 0,
            s.decoder + ', ' + s.decodeMs + ' ms');
        ok('the bitrate asked of the PC: 6 Mbps', s.kbps === 6000);
        const all = out.join('');
        ok('the stream runs as the uplink uid (12998), the gamepad thread as root', /"ev":"uid","uid":12998,"gid":12998/.test(all));
        ok('the GameStream requests come from the worker (as 12998)', /gamestream: pair: getservercert/.test(all));
        /* Sunshine's audio starts a couple of seconds into a session */
        const pcmSize = () => (fs.existsSync(PCM) ? fs.statSync(PCM).size : 0);
        for (let i = 0; i < 40 && pcmSize() < 48000 * 4; i++) await sleep(250);
        ok('audio reached the player', pcmSize() >= 48000 * 4, pcmSize() + ' bytes of S16LE stereo');
        s = await until(tok, '12 s into the stream', (x) => x.seconds >= 12, 15000);
        await sleep(500);
        const v = videoSeq();
        ok('the frames are in the renderer\'s frame file', v && v.magic === 0x4656474d && v.w === 1280 && v.h === 720 && v.seq > 60, JSON.stringify(v));
        const rlog = fs.readFileSync(RENDER_LOG, 'utf8');
        ok('the console: the whole area, black under the picture, the video fitted on top',
            /place 1920x720\+0\+0/.test(rlog) && /pixmap 2 4x4 rgbx/.test(rlog) && /frame ops 18,19/.test(rlog) && /show true/.test(rlog),
            rlog.split('\n').filter(Boolean).join(', '));
        ok('the stop hint: a picture over the video for the first 10 s, then the video alone',
            /pixmap 3 900x100 rgba/.test(rlog) && /frame ops 18,19,18\nframe ops 18,19\n/.test(rlog));
        ok('the console claims no touch (stopping a stream that did restarted the head unit)', !/claim/.test(rlog));
        ok('the phone pad: accepted while streaming', (await req('POST', '/api/pad', { b: 4096 }, tok)).code === 200 && (await req('POST', '/api/pad', { b: 0 }, tok)).code === 200);
        if (pads.length) s = await until(tok, 'the gamepads announced', hasPads, 6000);
        for (const pad of pads) {
            ok(pad.what + ' is announced to the PC while streaming', hasPad(s, pad), padNames(s));
            if (pad.usb) ok('the USB pad\'s LED set to its player (01 03 06..09 on its OUT endpoint)', /usbip_pad: out 01 03 0[6-9]/.test(pad.err()), pad.err().trim().split('\n').pop());
        }
        s = await until(tok, 'the phone pad listed', (x) => x.pads.some((q) => q.name === 'Phone'), 5000);
        ok('the phone pad is listed as a controller', s.pads.some((q) => q.name === 'Phone'));

        st = await control({ cmd: 'stop' });
        ok('the iDrive app: status first, then stop', st[0].ev === 'status' && st[0].state === 'streaming' && st[1].ev === 'status');
        s = await until(tok, 'ended', (x) => x.state === 'ended', 10000);
        ok('stopped: ended, the game still runs on the PC', s.state === 'ended' && s.canResume, s.note);
        /* the player too, though it ignores SIGTERM (as pcm_play.py blocked in ALSA): nothing plays after Stop */
        const pids = fs.readFileSync(PCM + '.pids', 'utf8').split('\n').filter(Boolean);
        const alive = () => pids.filter((p) => fs.existsSync('/proc/' + p) && !/^\S+ \(\S+\) Z/.test(fs.readFileSync('/proc/' + p + '/stat', 'utf8')));
        for (let i = 0; i < 20 && alive().length; i++) await sleep(100);
        ok('the audio player is gone within 2 s of Stop', alive().length === 0, pids.length + ' started, alive: ' + alive().join(' '));
        for (let i = 0; i < 20 && fs.existsSync(VIDEO); i++) await sleep(200);
        ok('the frame file is gone', !fs.existsSync(VIDEO));
        s = await until(tok, 'the PC busy', (x) => x.hosts[0].busy, 6000);
        ok('the PC shows the game running', s.hosts[0].busy && s.hosts[0].currentGame === app.id);

        st = await control({ cmd: 'resume' });
        ok('the iDrive app: resume', st[1].ev === 'status');
        s = await until(tok, 'streaming again', (x) => x.state === 'streaming' && x.frames > 30, 25000);
        ok('resumed: streaming again', s.state === 'streaming' && s.frames > 30, s.frames + ' frames');
        ok('the pad endpoint refuses nothing-to-do junk safely', (await req('POST', '/api/pad', { b: 'x', lx: 1e9 }, tok)).code === 200);

        /* the ways out when the picture covers the screen: holding it (the touch PDUs, read passively) */
        fs.writeFileSync(TOUCH + '.tmp', holdCapture());
        fs.renameSync(TOUCH + '.tmp', TOUCH);
        s = await until(tok, 'stopped by holding the screen', (x) => x.state === 'ended', 10000);
        ok('holding the screen 2 s stops the stream (the car\'s touch PDUs, replayed)', s.state === 'ended' && /screen was held/.test(s.note || ''), s.note);
        ok('a held screen: the core read it from the PDUs, at the hold\'s place', /the screen held at 128\d,2\d\d/.test(out.join('')));
        await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        s = await until(tok, 'streaming after the hold', (x) => x.state === 'streaming' && x.frames > 30, 25000);
        /* only while parked: the iDrive app sends the car's speed */
        await control({ cmd: 'speed', kmh: 1.5 });
        s = (await req('GET', '/api/status', null, tok)).json;
        ok('1.5 km/h: still parked, still streaming', s.state === 'streaming' && !s.moving && s.speed === 1.5);
        await control({ cmd: 'speed', kmh: 20 });
        s = await until(tok, 'stopped by driving off', (x) => x.state === 'ended', 8000);
        ok('20 km/h: the stream stops', s.state === 'ended' && /car is moving/.test(s.note || ''), s.note);
        const refused = await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        ok('moving: no stream starts', refused.code === 400 && /only while parked/.test(refused.json.error), refused.json.error);
        await control({ cmd: 'speed', kmh: 0 });
        /* and the controller's quit combo */
        if (pads.length) {
            const pad = pads.filter((q) => q.usb)[0] || pads[0];
            await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
            s = await until(tok, 'streaming for the combo', (x) => x.state === 'streaming' && hasPad(x, pad), 25000);
            pad.proc.stdin.write('combo\n');
            s = await until(tok, 'stopped by the combo', (x) => x.state === 'ended', 8000);
            ok('Start + Back + LB + RB held 2 s on ' + pad.what + ' stops the stream', s.state === 'ended' && /Start \+ Back/.test(s.note || ''), s.note);
            await sleep(3500);   /* the pad lets go */
        }
        await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        s = await until(tok, 'streaming again', (x) => x.state === 'streaming' && x.frames > 30, 25000);
        if (pads.length) {
            s = await until(tok, 'the gamepads in the resumed stream', hasPads, 6000);
            for (const pad of pads) pad.proc.stdin.end();
            s = await until(tok, 'the gamepads gone', (x) => pads.every((pad) => !hasPad(x, pad)), 8000);
            for (const pad of pads) ok('unplugged mid-stream: ' + pad.what + ' leaves the stream, the stream goes on', !hasPad(s, pad) && s.state === 'streaming', padNames(s));
            pads = [];
        }

        const q = await req('POST', '/api/quit', {}, tok);
        ok('quit game', q.code === 200, q.json && q.json.error);
        s = await until(tok, 'the PC free', (x) => x.state !== 'streaming' && !x.hosts[0].busy, 10000);
        ok('quit: the stream stopped and the game closed on the PC', s.state !== 'streaming' && !s.hosts[0].busy, s.note);

        st = await control({ cmd: 'disable' });
        ok('the iDrive app: off', st[1].enabled === false);
        ok('off: the page says so', (await req('GET', '/', null, tok)).code === 503);
        st = await control({ cmd: 'stop' });
        ok('off: commands refused', st.some((m) => m.ev === 'error'));
        st = await control({ cmd: 'enable' });
        ok('the iDrive app: on again', st[1].enabled === true);

        const hosts = JSON.parse(fs.readFileSync(path.join(TMP, 'state', 'hosts.json'), 'utf8'));
        ok('the pairing is kept across restarts', hosts[0] && /BEGIN CERTIFICATE/.test(hosts[0].serverCert));
    } finally {
        for (const pad of pads) pad.proc.kill();
        srv.kill('SIGTERM');
        await sleep(1200);
        if (failed) console.log(out.join('').split('\n').filter((l) => !/ core: (done|Stopping|Cleaning|Starting|Initializing|Received)/.test(l)).slice(-80).join('\n'));
    }
    console.log(failed ? failed + ' failed' : 'all server tests passed');
}

main().then(() => process.exit(failed ? 1 : 0), (e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
