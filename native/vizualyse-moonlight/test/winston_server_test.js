// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Winston output end to end: server.js and moonlight-core in the head unit's
 * own root filesystem (its node, its libwayland, libgbm and i965), against a
 * real Sunshine (test/sunshine), with the unit's own Winston running beside
 * them (tools/winston-bench, the stub GPU: the unit's i965 imports, no
 * pixels). Pairs, turns "Winston output" on, plays on the centre console:
 * the stream reaches Winston as NV12 GPU buffers (Winston's own log says
 * it imported and drew them), mgu-render is never asked, the stop hint is
 * over the picture; Stop takes it all down; a restart of the tool has it
 * off. Run by test/run_winston_server_test.sh:
 *
 *   node test/winston_server_test.js <sunshine address>
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const sunshine = require('./sunshine_web.js');

const HOST = process.argv[2];
const HERE = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-winston-'));
const PORT = 18490;
const VIDEO = path.join(TMP, 'mgu-video');
const RENDER_LOG = path.join(TMP, 'render.log');
const WINSTON_LOG = '/out/winston.log';

let failed = 0;
const ok = (what, cond, more) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : '')); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const winstonLog = () => { try { return fs.readFileSync(WINSTON_LOG, 'latin1').replace(/\0/g, ''); } catch (e) { return ''; } };

function kit() {
    const k = path.join(TMP, 'kit');
    fs.mkdirSync(k);
    fs.chmodSync(TMP, 0o755);
    fs.chmodSync(k, 0o755);
    ['server.js', 'gamestream.js', 'gs_worker.js', 'firewall.js', 'console_out.js', 'cluster_render_client.js', 'control.js', 'page.html', 'pcm_play.py']
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

async function until(tok, what, test, ms) {
    const end = Date.now() + ms;
    let s = null;
    while (Date.now() < end) {
        s = (await req('GET', '/api/status', null, tok)).json;
        if (s && test(s)) return s;
        await sleep(300);
    }
    console.log('     (timed out waiting for ' + what + '; last status: ' + JSON.stringify(s && { state: s.state, error: s.error, frames: s.frames, winston: s.winston }) + ')');
    return s;
}

function start(k, out) {
    const env = Object.assign({}, process.env, {
        MOONLIGHT_STATE: path.join(TMP, 'state'), MOONLIGHT_PORT: String(PORT), MOONLIGHT_CTL_SOCKET: path.join(TMP, 'ctl.sock'), MOONLIGHT_NO_FIREWALL: '1',
        MOONLIGHT_RENDER_CLIENT: path.join(__dirname, 'fake', 'render_client.js'), MOONLIGHT_VIDEO_FILE: VIDEO,
        MOONLIGHT_PYTHON: path.join(TMP, 'python'), MOONLIGHT_TEST_PCM: path.join(TMP, 'pcm'), MOONLIGHT_TEST_RENDER_LOG: RENDER_LOG,
        MOONLIGHT_LINK_IP: '192.0.2.10', MOONLIGHT_DECODER: process.env.MOONLIGHT_TEST_DECODER || 'av', MOONLIGHT_SMALL_DIR: path.join(TMP, 'small'),
        MOONLIGHT_WINSTON: '/run/wayland/wayland-0',
    });
    const srv = spawn(process.execPath, [path.join(k, 'server.js')], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    srv.stdout.on('data', (d) => out.push(String(d)));
    srv.stderr.on('data', (d) => out.push(String(d)));
    return srv;
}

async function main() {
    if (!HOST) { console.error('usage: node test/winston_server_test.js <address>'); process.exit(2); }
    const k = kit();
    const out = [];
    let srv = start(k, out);
    let tok = null;
    for (let i = 0; i < 60 && !tok; i++) { await sleep(200); try { tok = fs.readFileSync(path.join(TMP, 'state', 'token'), 'utf8').trim(); } catch (e) { /* not yet */ } }
    await sleep(800);
    try {
        let s = (await req('POST', '/api/hosts/add', { address: HOST }, tok)).json;
        const h = s.hosts[0];
        s = (await req('POST', '/api/pair', { id: h.id }, tok)).json;
        await sunshine.typePin(HOST, s.pairing.pin);
        s = await until(tok, 'paired', (x) => x.hosts[0].paired && x.hosts[0].apps, 20000);
        ok('paired with Sunshine', s.hosts[0].paired);
        const app = s.hosts[0].apps.filter((a) => a.name === 'Desktop')[0];
        await req('POST', '/api/settings', { mode: '1280x720', fps: 30, audio: false }, tok);

        const on = await req('POST', '/api/winston', { on: true }, tok);
        ok('Winston output on', on.code === 200 && on.json && on.json.winston && on.json.winston.on === true, on.body.slice(0, 200));
        const p = await req('POST', '/api/play', { id: h.id, app: app.id }, tok);
        ok('play', p.code === 200, p.json && p.json.error);
        s = await until(tok, 'streaming', (x) => x.state === 'streaming' && x.frames > 60, 30000);
        ok('streaming, pictures decoded', s.state === 'streaming' && s.frames > 60, s.frames + ' pictures, ' + s.fps + ' fps, ' + s.decoder);
        ok('shown through Winston', s.winston && s.winston.via === 'winston', JSON.stringify(s.winston));
        const log = out.join('');
        ok('moonlight-core says so', /"ev":"output","via":"winston","what":"NV12 dmabufs 1280x720/.test(log), (log.match(/"ev":"output"[^}]*}/) || [''])[0]);
        const wl = winstonLog();
        ok('Winston imported and drew the stream as NV12 (the unit\'s i965)', /wrapping dmabuf: texid: \d+, size: 1280x720, format: NV12/.test(wl) && !/could not create egl image/.test(wl));
        ok('the stop hint over it', /loading shm buffer \(900x100/.test(wl));
        let rl = '';
        try { rl = fs.readFileSync(RENDER_LOG, 'utf8'); } catch (e) { /* none */ }
        ok('mgu-render never asked', !/video/.test(rl), rl.slice(0, 100));
        ok('the frame file is there (the way back)', fs.existsSync(VIDEO));

        await req('POST', '/api/stop', {}, tok);
        s = await until(tok, 'stopped', (x) => x.state === 'ended', 15000);
        await sleep(1000);
        ok('Stop: ended, the frame file gone', s.state === 'ended' && !fs.existsSync(VIDEO), s.state);
        /* our surface (0x565a0100 = 1448739072) leaves Winston with moonlight-core */
        ok('and our surface left Winston', /destroy surface 1448739072/.test(winstonLog()));

        srv.kill('SIGTERM');
        await sleep(2500);
        srv = start(k, out);
        await sleep(2500);
        s = await until(tok, 'up again', (x) => !!x.winston, 10000);
        ok('after a restart of the tool Winston output is still on (kept: the default since 2026-11-08)', s.winston && s.winston.on === true);
        const off = await req('POST', '/api/winston', { on: false }, tok);
        ok('compatibility mode (Winston off)', off.code === 200);
        srv.kill('SIGTERM');
        await sleep(2500);
        srv = start(k, out);
        await sleep(2500);
        s = await until(tok, 'up again', (x) => !!x.winston, 10000);
        ok('and compatibility mode is kept over a restart too', s.winston && s.winston.on === false);
    } catch (e) {
        ok('no exception', false, e.stack);
    }
    srv.kill('SIGTERM');
    await sleep(1500);
    if (failed) console.log(out.join('').split('\n').slice(-40).join('\n'));
    console.log(failed ? failed + ' failed' : 'all passed');
    process.exit(failed ? 1 : 0);
}

main();
