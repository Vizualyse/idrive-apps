// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The tool end to end, off the car: its kit assembled from component.json
 * (plus the unshipped sample theme) in a temp folder, server.js run against
 * a fake cluster-render speaking PROTOCOL.md's framing, driven over its
 * control socket. Checks:
 *   - nothing reaches the cluster while off;
 *   - on: assets before layers, the art whole, binds to assets that exist,
 *     no layer at or below y 646, the theme's own limits;
 *   - the demo is refused while the speed is unknown or the car moves, runs
 *     at a standstill, and stops by itself when the car moves;
 *   - while it runs, only uniforms cross, at a few KB/s at most;
 *   - off drops every layer and asset.
 *   node test/tool_test.js       (Node 8 or later; Linux, macOS or Windows)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const HERE = path.resolve(__dirname, '..');
const ROOT = path.resolve(HERE, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzc-'));
const win = process.platform === 'win32';
const sockPath = (name) => win ? '\\\\.\\pipe\\vzc-' + process.pid + '-' + name : path.join(tmp, name + '.sock');
const RENDER = sockPath('render'), CTL = sockPath('ctl');

/* the kit */
/* platform.js wants a newer Node than the unit's: on Node 8 the copies must
 * already be there (CI syncs first) */
try { execFileSync(process.execPath, [path.join(ROOT, 'platform', 'platform.js'), 'sync', HERE], { stdio: 'ignore' }); }
catch (e) { if (!fs.existsSync(path.join(HERE, 'src', 'cluster_render_client.js'))) throw e; }
const kit = path.join(tmp, 'kit');
fs.mkdirSync(kit);
const comp = JSON.parse(fs.readFileSync(path.join(HERE, 'component.json'), 'utf8'));
comp.files.forEach((f) => {
    const from = path.join(HERE, f.from);
    if (!fs.existsSync(from)) throw new Error('component.json lists ' + f.from + ', which is missing (node tools/theme_build.js --list)');
    fs.copyFileSync(from, path.join(kit, f.path));
});
fs.readdirSync(path.join(HERE, 'themes', 'built')).filter((n) => /^samplec?\./.test(n))
    .forEach((n) => fs.copyFileSync(path.join(HERE, 'themes', 'built', n), path.join(kit, n)));
const state = path.join(tmp, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ enabled: false, theme: 'sample', source: 'car', bench: false }));
const theme = JSON.parse(fs.readFileSync(path.join(kit, 'sample.theme.json'), 'utf8'));

/* the fake cluster-render */
const ops = [];
let bytes = 0;
const render = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        bytes += d.length;
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) break;
            const type = buf[4], body = buf.slice(5, 4 + len);
            buf = buf.slice(4 + len);
            if (type === 0x4a) {
                const m = JSON.parse(body.toString('utf8'));
                ops.push(m);
                if (m.op === 'hello') {
                    const r = Buffer.from(JSON.stringify({ ev: 'hello', backend: 'test', targets: 'panel' }));
                    const h = Buffer.alloc(5); h.writeUInt32LE(r.length + 1, 0); h[4] = 0x4a;
                    s.write(Buffer.concat([h, r]));
                }
            } else if (type === 0x46) {
                ops.push({ op: 'frame', ref: body.readUInt32LE(0), rects: body.readUInt16LE(12), bytes: body.length - 14 - body.readUInt16LE(12) * 8 });
            }
        }
    });
    s.on('error', () => {});
});
render.listen(RENDER);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms, what) {
    for (let i = 0; i < ms / 50; i++) { if (f()) return; await wait(50); }
    throw new Error('timed out: ' + what);
}

let tool, ctl, statusNow = null, errors = [];
function send(c) { ctl.write(JSON.stringify(c) + '\n'); }

(async () => {
    tool = spawn(process.execPath, [path.join(kit, 'server.js')], {
        env: Object.assign({}, process.env, { CLUSTER_STATE: state, CLUSTER_RENDER_SOCKET: RENDER, CLUSTER_CTL_SOCKET: CTL, CTL_OAP_DIR: path.join(tmp, 'oap') }),
        stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    tool.stdout.on('data', (d) => { out += d; });
    tool.stderr.on('data', (d) => { out += d; });
    await until(() => ops.some((m) => m.op === 'hello'), 5000, 'the tool says hello to cluster-render');
    await wait(300);
    await until(() => { try { ctl = net.connect(CTL); return true; } catch (e) { return false; } }, 3000, 'control socket');
    ctl.setEncoding('utf8');
    let lb = '';
    ctl.on('data', (d) => {
        lb += d;
        let i;
        while ((i = lb.indexOf('\n')) >= 0) {
            const m = JSON.parse(lb.slice(0, i)); lb = lb.slice(i + 1);
            if (m.ev === 'status') statusNow = m; else if (m.ev === 'error') errors.push(m.error);
        }
    });
    await until(() => statusNow, 3000, 'first status');

    /* off: nothing drawn */
    assert.strictEqual(statusNow.enabled, false);
    assert.ok(!ops.some((m) => m.op === 'layer' || m.op === 'asset'), 'nothing drawn while off');

    /* on */
    send({ cmd: 'enable' });
    const nLayers = theme.layers.length, nAssets = Object.keys(theme.assets).length;
    await until(() => ops.filter((m) => m.op === 'layer').length === nLayers, 5000, 'every layer');
    await until(() => ops.filter((m) => m.op === 'frame').length >= nAssets, 5000, 'every asset (the art one of them) sent');
    const firstLayer = ops.findIndex((m) => m.op === 'layer');
    const lastAsset = ops.map((m) => m.op).lastIndexOf('asset');
    assert.ok(lastAsset < firstLayer, 'assets before layers');
    const assets = ops.filter((m) => m.op === 'asset');
    assert.strictEqual(assets.length, nAssets);
    ops.filter((m) => m.op === 'layer').forEach((l) => {
        assert.strictEqual(l.target, 'panel');
        assert.ok(l.y + l.h <= 646, 'layer ' + l.ref + ' stays above the car\'s strip');
        if (l.kind === 'effect') assert.ok(/#version 100/.test(l.fs), 'an effect carries its shader');
    });
    /* the art goes as its tiles and their map (THEMES.md "Static art"): one
     * RGBA asset, whole, far smaller than the 1920 x 646 picture */
    const A = theme.assets.art;
    assert.ok(A.tile > 0 && A.map, 'the built art is tiled');
    const art = assets.filter((a) => a.w === A.w && a.h === A.h && a.format === 'rgba8')[0];
    assert.ok(art, 'the art is an asset');
    assert.ok(art.w <= 2048 && art.h <= 2048, 'the art\'s tiles fit a texture');
    const artFrame = ops.filter((m) => m.op === 'frame' && m.ref === art.ref)[0];
    assert.strictEqual(artFrame.bytes, A.w * A.h * 4, 'the art goes whole');
    assert.ok(artFrame.bytes < 1920 * 646 * 4 / 2, 'the tiled art is under half the picture: ' + artFrame.bytes + ' bytes');
    ops.filter((m) => m.op === 'bind').forEach((b) => assert.ok(assets.some((a) => a.ref === b.asset), 'bind to a known asset'));

    /* the demo: only at a standstill (bench is off) */
    errors = [];
    send({ cmd: 'source', source: 'demo' });
    await until(() => errors.length, 2000, 'demo refused');
    assert.ok(/parked/.test(errors[0]), 'demo refused while the speed is unknown: ' + errors[0]);
    send({ cmd: 'speed', kmh: 0 });
    await wait(100);
    send({ cmd: 'source', source: 'demo' });
    await wait(400);
    const before = ops.length, b0 = bytes;
    await wait(2000);
    const during = ops.slice(before);
    assert.ok(during.some((m) => m.op === 'uniform' && m.name === 'u_val'), 'the gauge moves');
    assert.ok(during.every((m) => m.op === 'uniform' || m.op === 'set'), 'only uniforms and sets while it runs');
    const rate = (bytes - b0) / 2 / 1024;
    assert.ok(rate < 30, 'uniform traffic ' + rate.toFixed(1) + ' KB/s');
    console.log('ok   demo drive: ' + rate.toFixed(1) + ' KB/s of uniforms');

    /* the car moves: the demo stops */
    send({ cmd: 'speed', kmh: 40 });
    await until(() => statusNow.source === 'car', 3000, 'demo stopped while moving');
    console.log('ok   demo stops when the car moves');

    /* Sport and Comfort: no drive mode known, so the family's Comfort theme
     * (samplec) runs; Sport by hand switches to sample, which shares every
     * texture: the switch sends layers, no textures */
    await until(() => statusNow.showing === 'samplec', 6000, 'the car\'s source with no drive mode: Comfort (samplec), within the 3 s a theme is held');
    await wait(300);
    const before2 = ops.length;
    send({ cmd: 'mode', mode: 'sport' });
    await until(() => ops.slice(before2).filter((m) => m.op === 'layer').length === nLayers, 3000, 'the Sport theme');
    await wait(300);
    const sw = ops.slice(before2);
    assert.ok(!sw.some((m) => m.op === 'asset' || m.op === 'frame'), 'a switch within a family sends no shared texture');
    assert.ok(!sw.some((m) => m.op === 'drop' && assets.some((a) => a.ref === m.ref)), 'the shared textures stay');
    console.log('ok   Comfort to Sport in a family: ' + nLayers + ' layers made again, no texture sent');

    /* off: everything dropped */
    send({ cmd: 'disable' });
    await wait(500);
    const made = ops.filter((m) => m.op === 'layer' || m.op === 'asset').map((m) => m.ref).sort();
    const dropped = ops.filter((m) => m.op === 'drop').map((m) => m.ref).sort();
    assert.deepStrictEqual(dropped, made, 'off drops every layer and asset');
    console.log('ok   ' + nLayers + ' layers and ' + nAssets + ' assets made in order, art whole, under y 646, dropped when off');
    finish(0);
})().catch((e) => { console.error('FAIL ' + e.message); finish(1); });

function finish(code) {
    try { if (ctl) ctl.destroy(); } catch (e) { /* gone */ }
    if (tool) tool.kill('SIGTERM');
    render.close();
    setTimeout(() => process.exit(code), 300);
}
