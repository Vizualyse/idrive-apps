// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool end to end off the car: server.js in the head unit in a box
 * (test/unit), against a real Sunshine (test/sunshine), driven through the
 * phone page's API and the iDrive app's control socket. The renderer and
 * the speakers are stand-ins (test/fake): the frames land in the frame file
 * as on the car, the audio in a file. With MOONLIGHT_TEST_PAD (test/uinput_pad,
 * needs /dev/uinput and the host's /dev), a virtual USB gamepad too: found
 * while idle, announced to the PC while streaming, gone when unplugged. Run by test/run_sunshine_test.sh:
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
const PAD = process.env.MOONLIGHT_TEST_PAD;
const PAD_NAME = 'Test Xbox Pad';

let failed = 0;
const ok = (what, cond, more) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : '')); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* the tool's files as the kit lays them out, with the stand-ins */
function kit() {
    const k = path.join(TMP, 'kit');
    fs.mkdirSync(k);
    ['server.js', 'gamestream.js', 'firewall.js', 'console_out.js', 'control.js', 'page.html', 'pcm_play.py']
        .forEach((f) => fs.copyFileSync(path.join(HERE, 'src', f), path.join(k, f)));
    ['moonlight-core', 'ffmpeg'].forEach((f) => { fs.copyFileSync(path.join(HERE, 'build', f), path.join(k, f)); fs.chmodSync(path.join(k, f), 0o755); });
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
    let pad = null;
    if (PAD) {
        pad = spawn(PAD, ['300'], { stdio: ['pipe', 'pipe', 'inherit'] });
        const ready = await new Promise((r) => { pad.stdout.once('data', (d) => r(String(d).trim())); pad.on('exit', (c) => r('exit ' + c)); });
        if (!/^ready \/dev\/input\/event\d+/.test(ready)) { console.log('skip the gamepad checks: ' + ready); pad = null; } else console.log('     virtual gamepad: ' + ready);
    }
    const hasPad = (x) => x && x.pads.some((q) => q.name === PAD_NAME);
    const env = Object.assign({}, process.env, {
        MOONLIGHT_STATE: path.join(TMP, 'state'), MOONLIGHT_PORT: String(PORT), MOONLIGHT_CTL_SOCKET: SOCK, MOONLIGHT_NO_FIREWALL: '1',
        MOONLIGHT_RENDER_CLIENT: path.join(__dirname, 'fake', 'render_client.js'), MOONLIGHT_VIDEO_FILE: VIDEO,
        MOONLIGHT_PYTHON: path.join(TMP, 'python'), MOONLIGHT_TEST_PCM: PCM, MOONLIGHT_TEST_RENDER_LOG: RENDER_LOG,
        MOONLIGHT_LINK_IP: '192.0.2.10',
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
        if (pad) {
            s = await until(tok, 'the gamepad found', hasPad, 8000);
            ok('a USB gamepad is found while idle', hasPad(s), s.pads.map((q) => q.name).join(', '));
        }

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

        s = (await req('POST', '/api/settings', { mode: '1280x720', fps: 30, bitrate: 6000, audio: true, volume: 50 }, tok)).json;
        ok('stream settings kept', s.settings.mode === '1280x720' && s.settings.fps === 30 && s.settings.volume === 50);

        const p = await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        ok('play', p.code === 200, p.json && p.json.error);
        s = await until(tok, 'streaming', (x) => x.state === 'streaming' && x.frames > 60, 25000);
        ok('streaming, frames decoded', s.state === 'streaming' && s.frames > 60, s.frames + ' frames, ' + s.fps + ' fps, ' + s.size);
        /* Sunshine's audio starts a couple of seconds into a session */
        const pcmSize = () => (fs.existsSync(PCM) ? fs.statSync(PCM).size : 0);
        for (let i = 0; i < 40 && pcmSize() < 48000 * 4; i++) await sleep(250);
        ok('audio reached the player', pcmSize() >= 48000 * 4, pcmSize() + ' bytes of S16LE stereo');
        const v = videoSeq();
        ok('the frames are in the renderer\'s frame file', v && v.magic === 0x4656474d && v.w === 1280 && v.h === 720 && v.seq > 60, JSON.stringify(v));
        const rlog = fs.readFileSync(RENDER_LOG, 'utf8');
        ok('the renderer placed the video, centred, and shows it', /place 1280x720\+320\+0/.test(rlog) && /show true/.test(rlog), rlog.split('\n').filter(Boolean).join(', '));
        ok('the phone pad: accepted while streaming', (await req('POST', '/api/pad', { b: 4096 }, tok)).code === 200 && (await req('POST', '/api/pad', { b: 0 }, tok)).code === 200);
        if (pad) {
            s = await until(tok, 'the gamepad announced', hasPad, 6000);
            ok('the gamepad is announced to the PC while streaming', hasPad(s), s.pads.map((q) => q.slot + ' ' + q.name).join(', '));
        }
        s = await until(tok, 'the phone pad listed', (x) => x.pads.some((q) => q.name === 'Phone'), 5000);
        ok('the phone pad is listed as a controller', s.pads.some((q) => q.name === 'Phone'));

        let st = await control({ cmd: 'stop' });
        ok('the iDrive app: status first, then stop', st[0].ev === 'status' && st[0].state === 'streaming' && st[1].ev === 'status');
        s = await until(tok, 'ended', (x) => x.state === 'ended', 10000);
        ok('stopped: ended, the game still runs on the PC', s.state === 'ended' && s.canResume, s.note);
        for (let i = 0; i < 20 && fs.existsSync(VIDEO); i++) await sleep(200);
        ok('the frame file is gone', !fs.existsSync(VIDEO));
        s = await until(tok, 'the PC busy', (x) => x.hosts[0].busy, 6000);
        ok('the PC shows the game running', s.hosts[0].busy && s.hosts[0].currentGame === app.id);

        st = await control({ cmd: 'resume' });
        ok('the iDrive app: resume', st[1].ev === 'status');
        s = await until(tok, 'streaming again', (x) => x.state === 'streaming' && x.frames > 30, 25000);
        ok('resumed: streaming again', s.state === 'streaming' && s.frames > 30, s.frames + ' frames');
        if (pad) {
            s = await until(tok, 'the gamepad in the resumed stream', hasPad, 6000);
            pad.stdin.end();
            s = await until(tok, 'the gamepad gone', (x) => !hasPad(x), 8000);
            ok('unplugged mid-stream: the gamepad leaves the stream, the stream goes on', !hasPad(s) && s.state === 'streaming');
            pad = null;
        }
        ok('the pad endpoint refuses nothing-to-do junk safely', (await req('POST', '/api/pad', { b: 'x', lx: 1e9 }, tok)).code === 200);

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
        if (pad) pad.kill();
        srv.kill('SIGTERM');
        await sleep(1200);
        if (failed) console.log(out.join('').split('\n').filter((l) => !/ core: (done|Stopping|Cleaning|Starting|Initializing|Received)/.test(l)).slice(-80).join('\n'));
    }
    console.log(failed ? failed + ' failed' : 'all server tests passed');
}

main().then(() => process.exit(failed ? 1 : 0), (e) => { console.log('FAIL ' + (e && e.stack)); process.exit(1); });
