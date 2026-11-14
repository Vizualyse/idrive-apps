// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The theme picker on the central screen, off the car:
 *   - its look (picker_view.js): every target 50 px or more and inside the
 *     app area, none overlapping; eight families with both modes; every
 *     family drawn in both looks; only changed regions sent again;
 *   - the tool end to end: its kit assembled from component.json in a temp
 *     folder, server.js against a fake cluster-render and a fake mgu-render
 *     client (test/fake_render_client.js), touches from a stand-in reader
 *     (test/fake_touch.js), driven over the control socket as the iDrive app
 *     drives it: shown in the app area as one opaque pixmap; a tap on a tile
 *     redraws a part; Try refused until the car is known to stand still,
 *     then a theme on the cluster for a moment and back; Use turns themes on
 *     with the family shown; a swipe goes to the next family; Sport /
 *     Comfort; hidden when the car moves, refused while it moves; off.
 *   node test/picker_test.js [out.png]   (the last picture, to look at)
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
const view = require('../src/picker_view.js');
const { Canvas } = require('../src/ui_draw.js');
const { writePng } = require('../src/png.js');
const { loadAssets, families, dirty } = require('../src/picker.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzp-'));
const win = process.platform === 'win32';
const sockPath = (name) => win ? '\\\\.\\pipe\\vzp-' + process.pid + '-' + name : path.join(tmp, name + '.sock');
const RENDER = sockPath('render'), CTL = sockPath('ctl');
const OUT = process.argv[2] || path.join(tmp, 'picker.png');

/* the kit */
try { execFileSync(process.execPath, [path.join(ROOT, 'platform', 'platform.js'), 'sync', HERE], { stdio: 'ignore' }); }
catch (e) { if (!fs.existsSync(path.join(HERE, 'src', 'cluster_render_client.js'))) throw e; }
const kit = path.join(tmp, 'kit');
fs.mkdirSync(kit);
const comp = JSON.parse(fs.readFileSync(path.join(HERE, 'component.json'), 'utf8'));
comp.files.forEach((f) => fs.copyFileSync(path.join(HERE, f.from), path.join(kit, f.path)));
const themes = fs.readdirSync(kit).filter((n) => /\.theme\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(kit, n), 'utf8')))
    .map((t) => ({ id: t.id, title: t.title, family: t.family, mode: t.mode }));

/* ---- the look ---- */
const fams = families(themes);
assert.strictEqual(fams.length, 8, 'eight families');
fams.forEach((f) => assert.ok(f.sport && f.comfort, f.family + ' has a Sport and a Comfort theme'));
const base = { families: fams, sel: 0, look: 'sport', enabled: true, inUse: fams[0].family, mode: 'auto', trying: null, canTry: true, line: 'x', pressed: null };
const targets = view.layout(base);
targets.forEach((r) => {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= view.AREA.w && r.y + r.h <= view.AREA.h, r.id + ' inside the app area');
    if (r.id !== 'hero') assert.ok(r.w >= 50 && r.h >= 50, r.id + ' is at least 50 px (' + r.w + 'x' + r.h + ')');
});
targets.filter((r) => r.id !== 'hero').forEach((a, i, all) => all.slice(i + 1).forEach((b) => {
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, a.id + ' and ' + b.id + ' overlap');
}));
const centre = (id, m) => { const r = view.layout(m || base).filter((t) => t.id === id)[0]; return [r.x + r.w / 2, r.y + r.h / 2]; };
targets.forEach((r) => assert.strictEqual(view.hit(base, r.x + r.w / 2, r.y + r.h / 2), r.id, 'a touch at the middle of ' + r.id + ' hits it'));
const assets = loadAssets(kit);
const cv = new Canvas(view.AREA.w, view.AREA.h);
let slowest = 0;
fams.forEach((f, i) => ['sport', 'comfort'].forEach((look) => {
    assert.ok(assets.hero(f[look]) && assets.thumb(f[look]), f[look] + ' has a preview and a tile');
    const t0 = Date.now();
    view.render(cv, Object.assign({}, base, { sel: i, look: look }), assets);
    slowest = Math.max(slowest, Date.now() - t0);
}));
const a1 = Buffer.from(cv.px);
assert.deepStrictEqual(dirty(a1, cv.px, cv.w, cv.h), [], 'nothing changed, nothing sent');
view.render(cv, Object.assign({}, base, { sel: 7, look: 'comfort', pressed: 'try' }), assets);
const a2 = Buffer.from(cv.px);
view.render(cv, Object.assign({}, base, { sel: 7, look: 'comfort', pressed: null }), assets);
const d = dirty(a2, cv.px, cv.w, cv.h), area = d.reduce((s, r) => s + r.w * r.h, 0);
const tryBox = view.layout(base).filter((t) => t.id === 'try')[0];
assert.ok(d.length && area < cv.w * cv.h / 10, 'a press redraws a small part (' + area + ' px)');
d.forEach((r) => assert.ok(r.y + r.h > tryBox.y && r.y < tryBox.y + tryBox.h, 'only the pressed button\'s rows'));
console.log('ok   the look: ' + targets.length + ' targets of 50 px or more, 8 families in both looks (slowest picture ' + slowest + ' ms), a press redraws ' + area + ' px');

/* ---- the tool end to end ---- */
const render = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (dd) => {
        buf = Buffer.concat([buf, dd]);
        while (buf.length >= 5) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) break;
            const type = buf[4], body = buf.slice(5, 4 + len);
            buf = buf.slice(4 + len);
            if (type !== 0x4a) continue;
            const m = JSON.parse(body.toString('utf8'));
            crOps.push(m);
            if (m.op === 'hello') {
                const r = Buffer.from(JSON.stringify({ ev: 'hello', backend: 'test', targets: 'panel' }));
                const h = Buffer.alloc(5); h.writeUInt32LE(r.length + 1, 0); h[4] = 0x4a;
                s.write(Buffer.concat([h, r]));
            }
        }
    });
    s.on('error', () => {});
});
const crOps = [];
render.listen(RENDER);

const state = path.join(tmp, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'settings.json'), JSON.stringify({ enabled: false, theme: fams[0].family, mode: 'auto', source: 'car', bench: false }));
const LOG = path.join(tmp, 'render.log'), TOUCH = path.join(tmp, 'touch.txt');
const AREA = { x: 108, y: 82 };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms, what) {
    for (let i = 0; i < ms / 50; i++) { if (f()) return; await wait(50); }
    throw new Error('timed out: ' + what);
}
function logged() { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } }
/* touches at app area points: a tap, or a swipe from one point to another */
async function touch(lines) {
    await until(() => !fs.existsSync(TOUCH), 3000, 'the reader took the last touches');
    fs.writeFileSync(TOUCH, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify({ ev: 'touch', p: l[0], x: Math.round(l[1] + AREA.x), y: Math.round(l[2] + AREA.y) }))).join('\n') + '\n');
    await until(() => !fs.existsSync(TOUCH), 3000, 'the reader took the touches');
    await wait(250);
}
const tap = (p) => touch([[1, p[0], p[1]], 'wait 60', [2, p[0] + 2, p[1] + 1], 'wait 60', [3, p[0] + 2, p[1] + 1]]);

let tool, ctl, statusNow = null, errors = [], out = '';
function send(c) { ctl.write(JSON.stringify(c) + '\n'); }

(async () => {
    tool = spawn(process.execPath, [path.join(kit, 'server.js')], {
        env: Object.assign({}, process.env, { CLUSTER_STATE: state, CLUSTER_RENDER_SOCKET: RENDER, CLUSTER_CTL_SOCKET: CTL, CTL_OAP_DIR: path.join(tmp, 'oap'),
            CLUSTER_RENDER_CLIENT: path.join(HERE, 'test', 'fake_render_client.js'), CLUSTER_TEST_RENDER_LOG: LOG, CLUSTER_TRY_MS: '1500',
            CLUSTER_TOUCH_CMD: JSON.stringify([process.execPath, path.join(HERE, 'test', 'fake_touch.js'), TOUCH]) }),
        stdio: ['ignore', 'pipe', 'pipe'] });
    tool.stdout.on('data', (dd) => { out += dd; });
    tool.stderr.on('data', (dd) => { out += dd; });
    await until(() => crOps.some((m) => m.op === 'hello'), 5000, 'the tool says hello to cluster-render');
    await until(() => { try { ctl = net.connect(CTL); return true; } catch (e) { return false; } }, 3000, 'control socket');
    ctl.on('error', () => {});
    ctl.setEncoding('utf8');
    let lb = '';
    ctl.on('data', (dd) => {
        lb += dd;
        let i;
        while ((i = lb.indexOf('\n')) >= 0) {
            const m = JSON.parse(lb.slice(0, i)); lb = lb.slice(i + 1);
            if (m.ev === 'status') statusNow = m; else if (m.ev === 'error') errors.push(m.error);
        }
    });
    await until(() => statusNow, 5000, 'first status');
    assert.strictEqual(statusNow.picker, false);

    /* shown: in the app area, one opaque pixmap, whole at first */
    send({ cmd: 'picker', on: true });
    await until(() => logged().some((o) => o.op === 'frame'), 5000, 'the picker drawn');
    await until(() => statusNow.picker === true, 3000, 'status says the picker shows');
    const L = logged();
    const place = L.filter((o) => o.op === 'place')[0], pm = L.filter((o) => o.op === 'pixmap')[0];
    assert.deepStrictEqual([place.x, place.y, place.w, place.h], [108, 82, 1790, 638], 'placed in the app area');
    assert.deepStrictEqual([pm.w, pm.h, pm.format], [1790, 638, 'rgbx'], 'one opaque pixmap the size of the area');
    assert.strictEqual(L.filter((o) => o.op === 'pixels')[0].area, 1790 * 638, 'sent whole first');
    assert.ok(L.some((o) => o.op === 'show' && o.on === true), 'shown');
    assert.strictEqual(L.filter((o) => o.op === 'frame')[0].words[0], 18, 'drawn by an IMAGE op');
    console.log('ok   shown in the app area (1790x638+108+82) as one opaque pixmap');

    /* a tap on a tile: a part redrawn */
    const n0 = logged().length;
    await tap(centre('tile:3'));
    const px = logged().slice(n0).filter((o) => o.op === 'pixels');
    assert.ok(px.length >= 1, 'the tap redrew something');
    assert.ok(px.every((o) => o.area < 1790 * 638), 'only parts, never the whole picture: ' + px.map((o) => o.area).join(', '));
    console.log('ok   a tap on a tile redraws ' + px.length + ' parts (' + px.map((o) => o.area).join(', ') + ' px)');

    /* Try: refused while the speed is unknown (the button does nothing), then a moment on the cluster */
    await tap(centre('try'));
    await wait(300);
    assert.strictEqual(statusNow.trying, null, 'no try while the speed is unknown');
    send({ cmd: 'speed', kmh: 0 });
    await until(() => statusNow.canTry, 3000, 'standing still: Try allowed');
    const c0 = crOps.length;
    await tap(centre('try'));
    await until(() => statusNow.trying, 3000, 'a try');
    /* the picker opens on what the cluster would show: no drive mode known, Comfort */
    assert.strictEqual(statusNow.trying.id, fams[3].comfort, 'the tile chosen, in the look shown first (Comfort)');
    await until(() => crOps.slice(c0).some((m) => m.op === 'layer'), 3000, 'the try on the cluster');
    await until(() => !statusNow.trying, 4000, 'the try over');
    await wait(400);
    const made = crOps.slice(c0).filter((m) => m.op === 'layer' || m.op === 'asset').map((m) => m.ref).sort();
    const dropped = crOps.slice(c0).filter((m) => m.op === 'drop').map((m) => m.ref).sort();
    assert.deepStrictEqual(dropped, made, 'themes off: the try leaves nothing on the cluster');
    console.log('ok   Try: refused until the car is known to stand still, then ' + made.length + ' layers and assets for 1.5 s, all gone after');

    /* Sport, then Use: on with that family */
    await tap(centre('look:sport'));
    await tap(centre('use'));
    await until(() => statusNow.enabled, 3000, 'Use turns themes on');
    assert.strictEqual(statusNow.theme, fams[3].family, 'with the family shown');
    await until(() => statusNow.showing, 3000, 'a theme on the cluster');
    console.log('ok   Use: themes on with ' + statusNow.theme + ' (' + statusNow.showing + ')');

    /* a swipe to the left on the large preview: the next family */
    const h = view.HERO;
    await touch([[1, h.x + 700, h.y + 200], 'wait 40', [2, h.x + 600, h.y + 205], 'wait 40', [2, h.x + 450, h.y + 210], 'wait 40', [3, h.x + 400, h.y + 210]]);
    await tap(centre('use'));
    await until(() => statusNow.theme === fams[4].family, 3000, 'the swipe went to the next family');
    /* the > button: the one after */
    await tap(centre('next'));
    await tap(centre('use'));
    await until(() => statusNow.theme === fams[5].family, 3000, 'next went to the one after');
    await wait(300);
    const starts = out.split('\n').filter((l) => / theme: .*\(\d+ layers/.test(l) && l.indexOf(themes.filter((t) => t.id === statusNow.showing)[0].title) >= 0);
    assert.strictEqual(starts.length, 1, 'Use starts the theme once:\n' + starts.join('\n'));
    console.log('ok   a swipe and the > button go to the next family; Use starts its theme once');

    /* Sport always */
    await tap(centre('mode:sport'));
    await until(() => statusNow.mode === 'sport', 3000, 'mode Sport');
    await until(() => statusNow.showing === fams[5].sport, 5000, 'its Sport theme on the cluster');
    console.log('ok   Sport always: ' + statusNow.showing);

    /* the picture to look at (once the tap's redraw is sent: the status goes first) */
    await wait(500);
    fs.writeFileSync(OUT, writePng(1790, 638, fs.readFileSync(LOG + '.1.rgba')));

    /* the car moves: hidden; refused while moving */
    const n1 = logged().length;
    send({ cmd: 'speed', kmh: 40 });
    await until(() => statusNow.picker === false, 3000, 'hidden while moving');
    assert.ok(logged().slice(n1).some((o) => o.op === 'close'), 'its mgu-render client closed');
    errors = [];
    send({ cmd: 'picker', on: true });
    await until(() => errors.length, 3000, 'refused while moving');
    assert.ok(/parked/.test(errors[0]), errors[0]);
    console.log('ok   hidden when the car moves, refused while it moves');

    /* standing again: shown, Off, hidden by the app */
    send({ cmd: 'speed', kmh: 0 });
    send({ cmd: 'picker', on: true });
    await until(() => statusNow.picker === true, 3000, 'shown again');
    await wait(300);
    await tap(centre('off', Object.assign({}, base, { enabled: true })));
    await until(() => statusNow.enabled === false, 3000, 'Off');
    send({ cmd: 'picker', on: false });
    await until(() => statusNow.picker === false, 3000, 'hidden by the app');
    console.log('ok   Off from the picker; hidden by the app');
    console.log('     the last picture: ' + OUT);
    if (process.env.PICKER_TEST_LOG) console.log(out);
    finish(0);
})().catch((e) => { console.error('FAIL ' + e.message + '\n--- the tool said:\n' + out.slice(-3000)); finish(1); });

function finish(code) {
    try { if (ctl) ctl.destroy(); } catch (e) { /* gone */ }
    if (tool) tool.kill('SIGTERM');
    render.close();
    setTimeout(() => process.exit(code), 300);
}
