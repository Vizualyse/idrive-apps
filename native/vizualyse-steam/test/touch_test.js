// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Steam's touch screen, off the car:
 *   - its look (touch_view.js in the touch kit): every target 64 px or more,
 *     inside the app area, none overlapping (the kit's lint), in both tabs and
 *     every state drawn (a game running, starting, ended, none; a download;
 *     pages; an empty library; Steam off; the picture size's sheet open; no
 *     link); four games a page; the QR code decodes to the link's modules; a
 *     press redraws its button alone; the Library and Settings tabs as PNGs;
 *   - one picture at a time (touch_screen.js against a stand-in mgu-render
 *     client and a stand-in game): the app's screen state open, the touch
 *     screen; the game shown, the touch screen gone first; the game hidden or
 *     ended, the touch screen back while the state is open, not after; Show,
 *     Stop, Play (and its picture by itself once it draws), the pages, the
 *     picture's shape and size, upscaling, Steam on / off from taps; the List
 *     corner; the car moving (the game's picture goes, the touch screen
 *     stays and comes back in its place);
 *   - the tool end to end, where it can run (Linux, root: Node 8 in a
 *     container, below): server.js with no bundles, driven over the control
 *     socket as the iDrive app drives it, a stand-in mgu-render client, touches
 *     from a stand-in reader (test/fake_touch.js): {"cmd":"ui","on":true}
 *     shows the touch screen in the app area as one opaque pixmap; a tap on the
 *     Settings tab, the picture size from its sheet, upscaling, Steam off and
 *     on; the List corner sends {"ev":"list"} and hides it; the car moving
 *     keeps it, and it shows when asked while moving; off.
 *
 *   node test/touch_test.js [out dir]
 *   MSYS_NO_PATHCONV=1 docker run --rm -v "$PWD:/w" ml-unit:18.04-node8 sh -c \
 *       'cp -r /w /x && cd /x && node native/vizualyse-steam/test/touch_test.js'
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
/* the kit's copies (component.json "platform") */
try { execFileSync(process.execPath, [path.join(ROOT, 'platform', 'platform.js'), 'sync', HERE], { stdio: 'ignore' }); }
catch (e) { if (!fs.existsSync(path.join(HERE, 'src', 'ui_kit.js'))) throw e; }
const kit = require('../src/ui_kit.js');
const view = require('../src/touch_view.js');
const { writePng } = require('../src/ui_png.js');
const { SteamTouch, qrMatrix, nearest } = require('../src/touch_screen.js');
const qrcode = require('../src/qrcode.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vzs-ui-'));
const OUT = process.argv[2] || tmp;
const F = kit.loadFonts(path.join(HERE, 'src'));
const chipW = (t) => kit.chipW(F, t);
const now = () => { const t = process.hrtime(); return t[0] * 1e3 + t[1] / 1e6; };

/* ---- the look ---- */
const RES = [
    { id: '960x540', shape: '16:9', short: '960 × 540 · the default' }, { id: '1136x640', shape: '16:9', short: '1136 × 640 · the size it is shown at' },
    { id: '1280x720', shape: '16:9', short: '1280 × 720 · more than is shown' }, { id: '848x480', shape: '16:9', short: '848 × 480 · lighter' },
    { id: '640x360', shape: '16:9', short: '640 × 360 · lightest' }, { id: '1344x480', shape: 'screen', short: '1344 × 480' },
    { id: '1792x640', shape: 'screen', short: '1792 × 640 · the screen, full size' }, { id: '1120x400', shape: 'screen', short: '1120 × 400 · lighter' },
    { id: '896x320', shape: 'screen', short: '896 × 320 · half: with FSR' }, { id: '672x240', shape: 'screen', short: '672 × 240 · lightest: with FSR' },
];
const LINK = 'http://172.20.10.2:8494/?t=0123456789abcdef';
/* a game's profile (server.js profileOf), the defaults unless given */
const PROF = { resolution: '960x540', fps: 30, upscale: 'off', memMb: 2560, detail: 'normal', vulkan: true, vulkanDefault: true, vulkanCan: true,
    iris: true, irisCan: true, noSteam: false, steamApi: 1, steamStub: false, drm: null, noDrm: false, engine: null, arch: 'x64' };
const G = (o) => Object.assign({}, PROF, o);
const GAMES = [
    G({ appId: 1794680, name: 'Vampire Survivors', playable: true, why: null, upscale: 'fsr', engine: 'unity' }),
    G({ appId: 2868840, name: 'Slay the Spire 2', playable: true, why: null, resolution: '896x320', upscale: 'fsr', engine: 'godot' }),
    G({ appId: 504230, name: 'Celeste', playable: false, why: 'Downloading' }),
    G({ appId: 1145360, name: 'Hades', playable: false, why: '(no program found)' }),
    G({ appId: 646570, name: 'Slay the Spire', playable: false, why: '(USB stick not plugged in)' }),
    G({ appId: 10090, name: 'Call of Duty: World at War', playable: true, why: null, arch: 'x86', detail: 'lite', vulkan: true, steamStub: true,
        drm: { variant: '2.1', arch: 'x86', supported: true }, noDrm: true, noSteam: true }),
];
const BASE = { enabled: true, ready: true, line: { tone: 'ok', text: 'Vampire Survivors is running. Show puts it on the screen' }, right: 'Parked',
    game: { appId: 1794680, name: 'Vampire Survivors', state: 'running', fps: 28, gpuBuffers: true, note: null, shown: false },
    running: true, moving: false, library: GAMES, page: 0, open: null, download: { text: 'Downloading Celeste · 42 %', percent: 42 },
    resolutions: RES, fpsChoices: [30, 60], memChoices: [2048, 2560, 3072, 3584], link: LINK, qr: qrMatrix(LINK) };
const M = (o) => Object.assign({}, BASE, o || {});
/* nothing running: a game's start menu ready to play */
const IDLE = { game: null, running: false, download: null, line: { tone: 'ok', text: 'Ready: pick a game' } };
function widgets(m, tab, open) { return kit.frame(F, Object.assign(view.view(m, { tab: tab }, chipW), { tab: tab }), { open: open || null }); }
const STATES = [
    ['a game running, a download', M(), 'library'],
    ['page 2', M({ page: 1 }), 'library'],
    ['a game starting', M({ game: Object.assign({}, BASE.game, { state: 'starting', fps: 0 }), line: { tone: 'live', text: 'Starting Vampire Survivors (this can take a minute)...' } }), 'library'],
    ['a game ended', M({ game: Object.assign({}, BASE.game, { state: 'ended', note: 'the game ended before it drew anything (exit 1)' }), running: false, download: null }), 'library'],
    ['nothing ran', M({ game: null, running: false, download: { text: 'Steam Guard asks for a code: answer on the phone page', percent: null } }), 'library'],
    ['no games', M({ game: null, running: false, library: [], download: null }), 'library'],
    ['Steam off', M({ enabled: false, game: null, running: false, library: [], download: null, link: null, qr: null }), 'library'],
    ['moving', M({ moving: true, right: 'Moving · 19 mph' }), 'library'],
    ['Settings', M(), 'settings'],
    ['Settings, no link', M({ link: null, qr: null }), 'settings'],
    ['Settings, Steam off', M({ enabled: false, link: null, qr: null }), 'settings'],
    ['start menu, Picture', M(Object.assign({ open: 2868840 }, IDLE)), 'picture'],
    ['start menu, Picture, its sizes', M(Object.assign({ open: 2868840 }, IDLE)), 'picture', 'p:resolution'],
    ['start menu, Picture, memory', M(Object.assign({ open: 2868840 }, IDLE)), 'picture', 'p:memMb'],
    ['start menu, 16:9 sizes', M(Object.assign({ open: 1794680 }, IDLE)), 'picture', 'p:resolution'],
    ['start menu, How it runs', M(Object.assign({ open: 2868840 }, IDLE)), 'runs'],
    ['start menu, Steam DRM taken off', M(Object.assign({ open: 10090 }, IDLE)), 'runs'],
    ['start menu, the game running', M({ open: 1794680 }), 'picture'],
    ['start menu, the game running, How it runs', M({ open: 1794680 }), 'runs'],
    ['start menu, another game running', M({ open: 2868840 }), 'picture'],
    ['start menu, no program', M(Object.assign({ open: 1145360 }, IDLE)), 'picture'],
    ['start menu, moving', M(Object.assign({ open: 2868840, moving: true, right: 'Moving · 19 mph' }, IDLE)), 'picture'],
    ['start menu, no drivers', M(Object.assign({ open: 2868840, library: GAMES.map((g) => Object.assign({}, g, { vulkan: false, vulkanDefault: false, vulkanCan: false, iris: false, irisCan: false })) }, IDLE)), 'runs'],
];
STATES.forEach((s) => {
    const p = kit.lint(widgets(s[1], s[2], s[3]));
    assert.deepStrictEqual(p, [], s[0] + ': ' + p.join('; '));
});
const lib = widgets(M(), 'library');
assert.strictEqual(lib.filter((d) => /^game:/.test(d.id)).length, view.PER_PAGE, 'four games a page');
assert.strictEqual(widgets(M({ page: 1 }), 'library').filter((d) => /^game:/.test(d.id)).length, GAMES.length - view.PER_PAGE, 'the rest on page 2');
const byId = (ws, id) => ws.filter((d) => d.id === id)[0];
assert.strictEqual(byId(lib, 'prev').on, false, 'no page before the first');
assert.notStrictEqual(byId(lib, 'next').on, false, 'a next page');
assert.strictEqual(byId(lib, 'show').on, true, 'Show on: running, hidden, parked');
assert.strictEqual(byId(lib, 'game:1794680').on, true, 'a tile opens its menu while a game runs too');
assert.strictEqual(byId(lib, 'game:1145360').on, true, 'and without a program (its profile can be set)');
assert.strictEqual(byId(widgets(M({ enabled: false }), 'library'), 'game:2868840').on, false, 'no menu with Steam off');
assert.strictEqual(byId(lib, 'what:1794680').text, 'Running now');
assert.strictEqual(byId(lib, 'what:1145360').text, '(no program found)');
assert.strictEqual(byId(lib, 'what:2868840').text, '896 × 320 · FSR · Vulkan', 'a tile: its profile in a line');
assert.strictEqual(byId(widgets(M({ moving: true }), 'library'), 'show').on, false, 'no Show while moving');
assert.strictEqual(byId(widgets(M({ game: Object.assign({}, BASE.game, { shown: true }) }), 'library'), 'show').on, false, 'no Show while shown');
/* the start menu */
const menuOf = (o, tab, open) => widgets(M(o), tab, open);
const mp = menuOf(Object.assign({ open: 2868840 }, IDLE), 'picture');
assert.deepStrictEqual(view.view(M({ open: 2868840 }), { tab: 'library' }, chipW).tabs, view.MENU_TABS, 'its own tabs in place of Library and Settings');
assert.ok(!mp.some((d) => /^game:/.test(d.id)) && byId(mp, 'close') && byId(mp, 'play').on === true, 'the menu: back, Play, no tiles');
assert.strictEqual(byId(mp, 'menuTitle').text, 'Slay the Spire 2');
assert.strictEqual(byId(mp, 'p:shape').value, 'screen', 'its shape');
assert.strictEqual(byId(mp, 'p:resolution').value, '896x320', 'its size');
assert.strictEqual(byId(mp, 'p:upscale').value, 'fsr', 'its upscaling');
assert.strictEqual(byId(mp, 'p:fps').value, 30);
assert.strictEqual(byId(mp, 'p:memMb').value, 2560);
assert.deepStrictEqual(byId(menuOf(Object.assign({ open: 2868840 }, IDLE), 'picture', 'p:resolution'), '_sheet').options.map((o) => o.v),
    ['1344x480', '1792x640', '1120x400', '896x320', '672x240'], 'the sheet: the sizes of its shape');
assert.deepStrictEqual(byId(menuOf(Object.assign({ open: 1794680 }, IDLE), 'picture', 'p:resolution'), '_sheet').options.map((o) => o.v),
    ['960x540', '1136x640', '1280x720', '848x480', '640x360'], 'and of 16:9');
assert.strictEqual(byId(menuOf({ open: 2868840 }, 'picture'), 'play').on, false, 'no Play while another game runs');
assert.strictEqual(byId(menuOf({ open: 2868840 }, 'picture'), 'menuChip').text, 'Another game is running: stop it first');
assert.strictEqual(byId(menuOf(Object.assign({ open: 1145360 }, IDLE), 'picture'), 'play').on, false, 'no Play without a program');
assert.strictEqual(byId(menuOf(Object.assign({ open: 2868840, moving: true }, IDLE), 'picture'), 'play').on, false, 'no Play while moving');
const mr = menuOf({ open: 1794680 }, 'picture');
assert.ok(!byId(mr, 'play') && byId(mr, 'show').on === true && byId(mr, 'stop').on === true, 'its own game running: Show and Stop');
const runs = menuOf(Object.assign({ open: 2868840 }, IDLE), 'runs');
assert.strictEqual(byId(runs, 'p:vulkan').value, true);
assert.strictEqual(byId(runs, 'p:iris').on, false, 'iris only with Vulkan off');
assert.strictEqual(byId(runs, 'p:noDrm').on, false, 'no DRM wrapper: nothing to remove');
const cod = menuOf(Object.assign({ open: 10090 }, IDLE), 'runs');
assert.ok(byId(cod, 'p:noDrm').on !== false && byId(cod, 'p:noDrm').value === true && /SteamStub 2\.1 taken off/.test(byId(cod, 'p:noDrm').sub), 'SteamStub 2.1, taken off');
assert.strictEqual(byId(menuOf({ open: 1794680 }, 'runs'), 'p:noSteam').on, false, 'no file switches while it runs');
const st = widgets(M(), 'settings');
assert.ok(!byId(st, 'res') && !byId(st, 'upscale') && !byId(st, 'shape') && byId(st, 'client') && byId(st, 'enabled'), 'Settings: no picture settings, the Steam client and Steam');
/* the QR code: the link's modules, a light border */
const q = qrcode(0, 'M'); q.addData(LINK); q.make();
const mx = qrMatrix(LINK), n = q.getModuleCount();
assert.strictEqual(mx.length, n + 4);
for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) assert.strictEqual(mx[r + 2][c + 2], q.isDark(r, c));
assert.ok(mx[0].every((x) => !x) && mx[mx.length - 1].every((x) => !x), 'a light border');
/* the shape: the nearest size in pixels */
assert.strictEqual(nearest(RES, '960x540', 'screen').id, '1120x400');
assert.strictEqual(nearest(RES, '1792x640', '16:9').id, '1280x720');
const png = (name, ws, pressed) => { const s = new kit.Surface(F); s.render(ws, pressed || null); fs.writeFileSync(path.join(OUT, name), writePng(kit.AREA.w, kit.AREA.h, s.cv.px)); return s; };
const sf = new kit.Surface(F);
let t0 = now();
sf.render(lib, null);
const fullMs = now() - t0;
fs.writeFileSync(path.join(OUT, 'steam_library.png'), writePng(kit.AREA.w, kit.AREA.h, sf.cv.px));
const showB = byId(lib, 'show');
t0 = now();
const pr = sf.render(lib, { id: 'show', part: 0 });
const pressMs = now() - t0;
assert.deepStrictEqual(pr, [{ x: showB.x, y: showB.y, w: showB.w, h: showB.h }], 'a press redraws its button alone');
const tile = byId(lib, 'game:2868840');
const pt = sf.render(widgets(M({ running: false, game: null }), 'library'), null);
assert.ok(pt.length >= 1);
t0 = now();
png('steam_settings.png', st);
const setMs = now() - t0;
t0 = now();
png('steam_menu_picture.png', mp);
const menuMs = now() - t0;
png('steam_menu_sizes.png', menuOf(Object.assign({ open: 2868840 }, IDLE), 'picture', 'p:resolution'));
png('steam_menu_runs.png', cod);
png('steam_menu_running.png', mr);
const SHOTS = ['steam_library.png', 'steam_settings.png', 'steam_menu_picture.png', 'steam_menu_sizes.png', 'steam_menu_runs.png', 'steam_menu_running.png'];
console.log('ok   the look: ' + STATES.length + ' states lint clean, four games a page, a tile opens its start menu (its profile, Play), the QR code (' + n + ' modules), a press redraws ' + showB.w * showB.h +
    ' px; a full frame ' + fullMs.toFixed(1) + ' ms (Settings ' + setMs.toFixed(1) + ', the start menu ' + menuMs.toFixed(1) + '), a press ' + pressMs.toFixed(1) + ' ms (' + process.version + '); tile ' + tile.w + 'x' + tile.h);
console.log('     ' + SHOTS.map((f) => path.join(OUT, f)).join('\n     '));

/* ---- the games' pictures (art.js's, made here from synthetic ones) ---- */
{
    const art = require('../src/art.js');
    const pic = (w, h, f) => { const b = Buffer.alloc(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); b[(y * w + x) * 4] = c[0]; b[(y * w + x) * 4 + 1] = c[1]; b[(y * w + x) * 4 + 2] = c[2]; b[(y * w + x) * 4 + 3] = c[3]; } return { w: w, h: h, rgba: b }; };
    const poster = pic(616, 353, (x, y) => [x * 255 / 616, 120 + (y % 40) * 3, 255 - y * 255 / 353, 255]);
    const icon = pic(64, 64, (x, y) => ((x - 32) * (x - 32) + (y - 32) * (y - 32) < 900 ? [240, 200, 40, 255] : [0, 0, 0, 0]));
    const made = {
        tile: { 1794680: art.finish(art.cover(poster, view.TILE.w, view.TILE.h), true, false), 2868840: art.finish(art.onPlate(icon, view.TILE.w, view.TILE.h, view.plate(2868840), 96, 20), false, false),
            504230: art.finish(art.cover(poster, view.TILE.w, view.TILE.h), true, true) },
        thumb: { 1794680: art.finish(art.cover(poster, view.THUMB.w, view.THUMB.h), false, false) },
    };
    const withArt = (o) => M(Object.assign({ art: (id, which) => (made[which][id] ? { img: made[which][id], key: which + id } : null) }, o || {}));
    [['pictures, a game running', withArt(), 'library'], ['pictures, nothing running', withArt({ game: null, running: false }), 'library'], ['pictures, page 2', withArt({ page: 1 }), 'library']].forEach((s) => {
        const p = kit.lint(widgets(s[1], s[2]));
        assert.deepStrictEqual(p, [], s[0] + ': ' + p.join('; '));
    });
    const la = widgets(withArt({ game: null, running: false }), 'library');
    const ids = la.map((d) => d.id);
    ['1794680', '2868840', '504230'].forEach((id) => {
        assert.ok(ids.indexOf('art:' + id) >= 0 && ids.indexOf('art:' + id) < ids.indexOf('game:' + id), 'the picture under its tile ' + id);
        assert.strictEqual(byId(la, 'game:' + id).under, undefined, 'no plate over the picture ' + id);
    });
    assert.strictEqual(ids.indexOf('art:1145360'), -1, 'no picture: none drawn');
    assert.notStrictEqual(byId(la, 'game:1145360').under, undefined, 'no picture: the plate as before');
    const card = widgets(withArt(), 'library');
    assert.ok(byId(card, 'gameArt') && byId(card, 'title').x > view.THUMB.x + view.THUMB.w, 'the running game\'s thumb, its name after it');
    assert.strictEqual(byId(widgets(withArt({ game: null, running: false }), 'library'), 'gameArt'), undefined, 'no game: no thumb');
    const sa = new kit.Surface(F);
    sa.render(card, null);
    fs.writeFileSync(path.join(OUT, 'steam_library_art.png'), writePng(kit.AREA.w, kit.AREA.h, sa.cv.px));
    const sb = new kit.Surface(F);
    sb.render(la, null);
    const tb = byId(la, 'game:2868840'), redraw = sb.render(la, { id: 'game:2868840', part: 0 });
    assert.deepStrictEqual(redraw, [{ x: tb.x, y: tb.y, w: tb.w, h: tb.h }], 'a press on a pictured tile redraws that tile');
    fs.writeFileSync(path.join(OUT, 'steam_library_art_pressed.png'), writePng(kit.AREA.w, kit.AREA.h, sb.cv.px));
    /* the start menu: the game's thumb on its card, its name after it */
    const ma = widgets(withArt({ open: 1794680, game: null, running: false }), 'picture');
    assert.deepStrictEqual(kit.lint(ma), [], 'the start menu with its picture');
    assert.ok(byId(ma, 'menuArt') && byId(ma, 'menuTitle').x > byId(ma, 'menuArt').x + view.THUMB.w, 'its thumb, its name after it');
    const sm = new kit.Surface(F);
    sm.render(ma, null);
    fs.writeFileSync(path.join(OUT, 'steam_menu_art.png'), writePng(kit.AREA.w, kit.AREA.h, sm.cv.px));
    console.log('ok   the pictures: under their tiles, the plate without one, the running game\'s thumb, a press on a pictured tile, the start menu\'s thumb');
    console.log('     ' + ['steam_library_art.png', 'steam_library_art_pressed.png', 'steam_menu_art.png'].map((f) => path.join(OUT, f)).join('\n     '));
}

/* ---- one picture at a time ---- */
const clientPath = path.join(tmp, 'client.js');
fs.writeFileSync(clientPath, `
const EventEmitter = require('events');
const ops = [];
class RenderClient extends EventEmitter {
  constructor(name) { super(); this.name = name; ops.push({ op: 'new', name }); }
  connect() { setTimeout(() => this.emit('ready', { w: 1920, h: 720 }, { appArea: { x: 108, y: 82, w: 1790, h: 638 } }), 5); }
  mode() {} place(p) { ops.push({ op: 'place', p }); } show(on) { ops.push({ op: 'show', on }); }
  pixmap(id, w, h) { ops.push({ op: 'pixmap', w, h }); }
  pixels(id, rects) { ops.push({ op: 'pixels', area: rects.reduce((a, r) => a + r.w * r.h, 0) }); }
  frameWords() {} close() { ops.push({ op: 'close', name: this.name }); }
}
module.exports = { RenderClient, imageOp: () => new Uint32Array(7), ops };`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 60));
const T = { moving: false, gameShown: false, model: M({ game: null, running: false, download: null }), acts: [] };
let ui = null;
/* the server's show / hide, as server.js calls the touch screen around the game */
const showGame = () => { if (T.moving) return 'not while driving'; if (!T.model.running) return 'no game is running'; if (T.gameShown) return null; ui.gameUp(); T.gameShown = true; return null; };
const hideGame = () => { T.gameShown = false; ui.gameGone(); };
ui = new SteamTouch({ dir: path.join(HERE, 'src'), clientPath: clientPath, log: () => {}, touch: { python: path.join(tmp, 'none') },
    state: () => Object.assign({}, T.model), moving: () => T.moving, gameShown: () => T.gameShown,
    actions: {
        show: () => { T.acts.push(['show']); return showGame(); },
        stop: () => { T.acts.push(['stop']); return null; },
        play: (id) => { T.acts.push(['play', id]); return null; },
        game: (id, b) => {
            T.acts.push(['game', id, b]);
            T.model.library = T.model.library.map((g) => (g.appId === id ? Object.assign({}, g, b.reset ? { resolution: '960x540', upscale: 'off' } : b) : g));
            return null;
        },
        enable: (on) => { T.acts.push(['enable', on]); T.model.enabled = on; return null; },
    } });
let lists = 0;
ui.on('list', () => lists++);
const at = (id, dx, dy) => { const w = ui.ui.widgets.filter((d) => d.id === id)[0]; if (!w) throw new Error('no ' + id); return [108 + w.x + (dx === undefined ? w.w / 2 : dx), 82 + w.y + (dy === undefined ? w.h / 2 : dy)]; };
const tap = async (id, dx, dy) => { const p = at(id, dx, dy); ui.ui.onTouch(1, p[0], p[1]); await wait(30); ui.ui.onTouch(3, p[0] + 2, p[1] + 1); await wait(); };
const ops = () => require(clientPath).ops;
const upNow = () => { const o = ops(); let up = 0; o.forEach((x) => { if (x.op === 'new') up++; if (x.op === 'close') up--; }); return up; };
/* exactly one picture: never the touch screen and the game both */
const one = (what) => assert.ok(!(ui.shown() && T.gameShown) && upNow() <= 1, what + ': one picture at a time');

(async () => {
    assert.strictEqual(ui.want(true), null);
    await wait();
    assert.ok(ui.shown() && ops().some((o) => o.op === 'pixmap' && o.w === 1790 && o.h === 638), 'the screen state open: the touch screen');
    one('opened');
    /* a game: its tile opens its start menu, not the game; Play there, then its picture by itself once it draws */
    await tap('game:2868840');
    assert.strictEqual(T.acts.length, 0, 'a tile starts nothing');
    assert.ok(ui.ui.widgets.some((d) => d.id === 'play') && ui.ui.widgets.some((d) => d.id === 'p:resolution') && ui.open === 2868840, 'the tile: its start menu');
    await tap('play');
    assert.deepStrictEqual(T.acts.pop(), ['play', 2868840]);
    T.model = M({ game: Object.assign({}, BASE.game, { appId: 2868840, name: 'Slay the Spire 2', state: 'starting' }), running: true, download: null });
    ui.onGame({ o: { appId: 2868840 }, state: 'starting' });
    assert.ok(ui.shown() && !T.gameShown, 'starting: still the touch screen');
    T.model.game.state = 'running';
    ui.onGame({ o: { appId: 2868840 }, state: 'running' });
    await wait();
    assert.ok(T.gameShown && !ui.shown(), 'it draws: the game, the touch screen gone');
    one('the game up');
    /* hidden (the phone, or the app's hide): the touch screen back, the state still open */
    hideGame();
    await wait();
    assert.ok(ui.shown() && !T.gameShown, 'the game hidden: the touch screen back');
    one('back');
    /* Show from the touch screen */
    await tap('show');
    assert.ok(T.gameShown && !ui.shown(), 'Show: the game in its place');
    one('Show');
    /* the game ends: the touch screen back */
    T.model = M({ game: Object.assign({}, BASE.game, { appId: 2868840, name: 'Slay the Spire 2', state: 'ended', note: 'stopped' }), running: false, download: null });
    hideGame();
    await wait();
    assert.ok(ui.shown(), 'the game ended: the touch screen back');
    /* the app's state closed while the game is up: neither comes back */
    T.model.running = true;
    T.model.game.state = 'running';
    ui.refresh();
    await wait();
    await tap('show');
    assert.ok(T.gameShown);
    assert.strictEqual(ui.want(false), null);
    hideGame();
    await wait();
    assert.ok(!ui.shown() && !T.gameShown, 'the screen state closed: nothing back');
    /* opened again with the game up: the game stays, the touch screen when it goes */
    assert.strictEqual(showGame(), null);
    assert.strictEqual(ui.want(true), null);
    await wait();
    assert.ok(T.gameShown && !ui.shown(), 'opened over the game: the game stays');
    hideGame();
    await wait();
    assert.ok(ui.shown(), 'then the touch screen');
    console.log('ok   one picture at a time: the touch screen on the screen state; the game (Show, or a Play drawing) in its place; back when the game is hidden or ends; not once the state is closed');

    /* taps: Stop, the start menu (its profile), the pages, Settings */
    await tap('stop');
    assert.deepStrictEqual(T.acts.pop(), ['stop']);
    T.model = M({ game: null, running: false, download: null, library: GAMES.slice() });
    ui.refresh();
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === 'play'), 'still its start menu: Play again');
    await tap('p:shape', 130);
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { resolution: '640x360' }], '16:9: the size nearest to its 896x320');
    await wait(80);
    await tap('p:resolution');
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === '_sheet'), 'its sizes\' sheet');
    await tap('_sheet', 40, 6 + 66 * 3 + 30);
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { resolution: '848x480' }], 'a size from the sheet');
    await wait(80);
    await tap('p:upscale', 50);
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { upscale: 'off' }]);
    await tap('p:fps', 300);
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { fps: 60 }]);
    await tap('p:memMb');
    await wait(80);
    await tap('_sheet', 40, 6 + 66 * 3 + 30);
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { memMb: 3584 }], 'memory from its sheet');
    await wait(80);
    await tap('_tabs', 260, 30);
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === 'p:vulkan'), 'How it runs');
    await tap('p:vulkan');
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { vulkan: false }]);
    await tap('p:reset');
    assert.deepStrictEqual(T.acts.pop(), ['game', 2868840, { reset: true }]);
    await tap('close');
    await wait(80);
    assert.ok(ui.open === null && ui.ui.widgets.some((d) => d.id === 'game:2868840') && ui.ui.ui.tab === 'library', 'the back arrow: the library again');
    await tap('next');
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === 'game:10090') && !ui.ui.widgets.some((d) => d.id === 'game:1794680'), 'next: page 2');
    await tap('prev');
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === 'game:1794680'), 'prev: page 1');
    await tap('_tabs', 260, 30);
    await wait(80);
    assert.ok(ui.ui.widgets.some((d) => d.id === 'qr'), 'Settings: the QR code');
    await tap('enabled');
    assert.deepStrictEqual(T.acts.pop(), ['enable', false]);
    await wait(80);
    await tap('enabled');
    assert.deepStrictEqual(T.acts.pop(), ['enable', true]);
    console.log('ok   taps: a tile opens its start menu (Play there); its profile: the shape (its nearest size), a size and memory from their sheets, upscaling, frames, Vulkan, the defaults; back; the pages; Settings: Steam off and on');

    /* the List corner; the car moving */
    await tap('_list');
    assert.ok(lists === 1 && !ui.shown() && !ui.wanted, 'List: hidden, the app told');
    hideGame();
    await wait();
    assert.ok(!ui.shown(), 'and it stays down');
    assert.strictEqual(ui.want(true), null);
    await wait();
    assert.ok(ui.shown(), 'wanted again: shown');
    /* the car moving: the touch screen stays; the game's picture can't go
     * up; one already up goes (the server's hide), the touch screen back */
    const wasRunning = T.model.running;
    T.model.running = true;
    T.moving = true;
    assert.strictEqual(showGame(), 'not while driving', 'no game picture while moving');
    assert.ok(ui.shown(), 'moving: the touch screen stays');
    T.moving = false;
    assert.strictEqual(showGame(), null);
    assert.ok(!ui.shown(), 'the game up: the touch screen down');
    T.moving = true;
    hideGame();
    await wait();
    assert.ok(ui.shown(), 'driving hid the game: the touch screen back in its place');
    ui.want(false);
    assert.ok(!ui.shown(), 'hidden by the app');
    assert.strictEqual(ui.want(true), null, 'not refused while moving');
    await wait();
    assert.ok(ui.shown(), 'shown while moving');
    T.moving = false;
    T.model.running = wasRunning;
    ui.stop('done');
    one('the end');
    console.log('ok   the List corner hides it and tells the app; the car moving keeps it (the game\'s picture goes, the touch screen back in its place)');
    await endToEnd();
    console.log('all passed');
    process.exit(0);
})().catch((e) => { console.error('FAIL ' + (e.stack || e.message)); process.exit(1); });

/* ---- the tool end to end (Linux, root) ---- */
async function endToEnd() {
    if (process.platform !== 'linux' || !process.getuid || process.getuid() !== 0) {
        console.log('skip the tool end to end: needs Linux and root (Node 8 in a container, at the top)');
        return;
    }
    const LOG = path.join(tmp, 'render.log'), TOUCH = path.join(tmp, 'touch.txt'), CTL = path.join(tmp, 'ctl', 'ctl.sock');
    fs.writeFileSync(path.join(tmp, 'lease.json'), JSON.stringify({ ip: '172.20.10.2', dns: ['192.0.2.53'] }));
    /* a game installed under 0.3.2, with its settings then the tool's: they become the game's own */
    const STATE = path.join(tmp, 'root', 'state'), GAME = path.join(tmp, 'games', 'sts2');
    execFileSync('mkdir', ['-p', STATE, GAME]);
    fs.writeFileSync(path.join(GAME, 'SlayTheSpire2.exe'), 'not a program');
    fs.writeFileSync(path.join(STATE, 'settings.json'), JSON.stringify({ enabled: true, resolution: '1280x720', resDefault: 2, upscale: 'fsr', fps: 60, memMb: 3072 }));
    fs.writeFileSync(path.join(STATE, 'library.json'), JSON.stringify({ 2868840: { name: 'Slay the Spire 2', dir: GAME, exe: 'SlayTheSpire2.exe', args: [], engine: 'godot' } }));
    const out = [];
    const tool = spawn(process.execPath, [path.join(HERE, 'src', 'server.js')], { stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { STEAM_ROOT: path.join(tmp, 'root'), STEAM_RUN_DIR: path.join(tmp, 'run'), STEAM_DNS_FILE: path.join(tmp, 'dns'),
            STEAM_NO_FIREWALL: '1', STEAM_LEASE: path.join(tmp, 'lease.json'), STEAM_CTL_SOCKET: CTL, CTL_OAP_DIR: path.join(tmp, 'oap'), STEAM_PORT: '18494',
            STEAM_SWAP_MB: '0', STEAM_SWAP_DELAY_MS: '600000', STEAM_CGROUP_ROOT: path.join(tmp, 'nocg'), STEAM_DISK: path.join(tmp, 'nodisk'),
            STEAM_USB_MEDIA: path.join(tmp, 'media'), VZ_BUS_SOCKET: path.join(tmp, 'nobus.sock'),
            STEAM_RUNTIME_ARCHIVE: path.join(tmp, 'none.tgz'), STEAM_RENDER_CLIENT: path.join(HERE, 'test', 'fake_render_client.js'), STEAM_TEST_RENDER_LOG: LOG,
            STEAM_UI_TOUCH_CMD: JSON.stringify([process.execPath, path.join(HERE, 'test', 'fake_touch.js'), TOUCH]) }) });
    tool.stdout.on('data', (d) => out.push(String(d)));
    tool.stderr.on('data', (d) => out.push(String(d)));
    const until = async (f, ms, what) => { for (let i = 0; i < ms / 50; i++) { if (f()) return; await wait(50); } throw new Error('timed out: ' + what + '\n' + out.join('').slice(-3000)); };
    const logged = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
    let st = null, errors = [], lists2 = 0, sock = null;
    try {
        await until(() => fs.existsSync(CTL), 8000, 'the control socket');
        sock = net.connect(CTL);
        sock.setEncoding('utf8');
        let buf = '';
        sock.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
                if (m.ev === 'status') st = m; else if (m.ev === 'error') errors.push(m.error); else if (m.ev === 'list') lists2++;
            }
        });
        const send = (c) => sock.write(JSON.stringify(c) + '\n');
        await until(() => st, 5000, 'the first status');
        assert.strictEqual(st.ui, false);
        send({ cmd: 'speed', kmh: 0 });
        send({ cmd: 'ui', on: true });
        await until(() => st.ui === true && logged().some((l) => /^vizualyse_steam_ui pixels 1 1142020$/.test(l)), 5000, 'the touch screen, whole first');
        const L = logged();
        assert.ok(L.indexOf('vizualyse_steam_ui place 1790x638+108+82') >= 0 && L.indexOf('vizualyse_steam_ui pixmap 1 1790x638 rgbx') >= 0, 'in the app area, one opaque pixmap');
        assert.ok(L.indexOf('vizualyse_steam_ui show true') >= 0, 'shown');
        assert.strictEqual(st.uiWanted, true);
        console.log('ok   the tool: {"cmd":"ui","on":true} shows the touch screen in the app area (1790x638+108+82), one opaque pixmap');
        const sts2 = () => st.library.filter((x) => x.appId === 2868840)[0] || {};
        assert.ok(sts2().resolution === '1280x720' && sts2().upscale === 'fsr' && sts2().fps === 60 && sts2().memMb === 3072,
            'the 0.3.2 settings, the game\'s own now: ' + JSON.stringify(sts2()));
        const saved = JSON.parse(fs.readFileSync(path.join(STATE, 'settings.json'), 'utf8'));
        assert.ok(saved.resolution === undefined && saved.upscale === undefined && saved.fps === undefined && saved.memMb === undefined, 'and gone from the settings');
        console.log('ok   the tool: 0.3.2\'s picture, frames, upscaling and memory settings become each installed game\'s own, once');
        /* where a widget is: the view for the tool's state (tab; sheet: a dropdown open; menu: a start menu open) */
        const tapAt = async (id, tab, dx, dy, sheet, menu) => {
            const m = { enabled: st.enabled, ready: st.bundle === 'ready', line: {}, right: '', game: null, running: false, moving: false, page: 0, download: null,
                library: st.library.map((x) => Object.assign({ playable: true, why: null }, x)), open: menu || null,
                resolutions: RES, fpsChoices: st.choices.fps, memChoices: st.choices.memMb, link: st.link, qr: st.link ? [[true]] : null };
            const w = widgets(m, tab, sheet).filter((d) => d.id === id)[0];
            if (!w) throw new Error('no ' + id);
            const x = 108 + w.x + (dx === undefined ? w.w / 2 : dx), y = 82 + w.y + (dy === undefined ? w.h / 2 : dy);
            await until(() => !fs.existsSync(TOUCH), 3000, 'the reader took the last touches');
            fs.writeFileSync(TOUCH, [{ ev: 'touch', p: 1, x: Math.round(x), y: Math.round(y) }, 'wait 60', { ev: 'touch', p: 3, x: Math.round(x) + 2, y: Math.round(y) + 1 }]
                .map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
            await until(() => !fs.existsSync(TOUCH), 3000, 'the reader took the touches');
            await wait(250);
        };
        /* the game's tile: its start menu (nothing started), its profile changed there */
        await tapAt('game:2868840', 'library');
        await tapAt('p:resolution', 'picture', undefined, undefined, null, 2868840);
        await tapAt('_sheet', 'picture', 40, 6 + 66 * 4 + 30, 'p:resolution', 2868840);
        await until(() => sts2().resolution === '640x360', 3000, 'its picture size from the sheet');
        await tapAt('p:upscale', 'picture', 760 - 60, undefined, null, 2868840);
        await until(() => sts2().upscale === 'fsr-soft', 3000, 'its upscaling');
        await tapAt('p:fps', 'picture', 40, undefined, null, 2868840);
        await until(() => sts2().fps === 30, 3000, 'its frames');
        assert.ok(!st.running && !(st.game), 'a tile and its menu start nothing');
        await wait(400);
        fs.writeFileSync(path.join(OUT, 'steam_tool_menu.png'), writePng(1790, 638, fs.readFileSync(LOG + '.vizualyse_steam_ui.rgba')));
        const lib2 = JSON.parse(fs.readFileSync(path.join(STATE, 'library.json'), 'utf8'))[2868840];
        assert.ok(lib2.resolution === '640x360' && lib2.upscale === 'fsr-soft' && lib2.fps === 30, 'kept in the library: ' + JSON.stringify(lib2));
        await tapAt('_tabs', 'picture', 260, 30, null, 2868840);
        await tapAt('p:reset', 'runs', undefined, undefined, null, 2868840);
        await until(() => sts2().resolution === '960x540' && sts2().upscale === 'off' && sts2().memMb === 2560, 3000, 'its defaults');
        await tapAt('close', 'runs', undefined, undefined, null, 2868840);
        console.log('ok   the tool: a tile opens its start menu; a size from its sheet, upscaling and frames kept for the game; the defaults; back (' + path.join(OUT, 'steam_tool_menu.png') + ')');
        await tapAt('_tabs', 'library', 260, 30);
        await tapAt('enabled', 'settings');
        await until(() => st.enabled === false, 3000, 'Steam off');
        await tapAt('enabled', 'settings');
        await until(() => st.enabled === true, 3000, 'Steam on');
        await wait(400);
        fs.writeFileSync(path.join(OUT, 'steam_tool_settings.png'), writePng(1790, 638, fs.readFileSync(LOG + '.vizualyse_steam_ui.rgba')));
        console.log('ok   the tool: taps on the Settings tab: Steam off and on (' + path.join(OUT, 'steam_tool_settings.png') + ')');
        await tapAt('_list', 'settings');
        await until(() => lists2 === 1 && st.ui === false && st.uiWanted === false, 3000, 'List');
        assert.ok(logged().indexOf('vizualyse_steam_ui close') >= 0, 'its client closed');
        send({ cmd: 'ui', on: true });
        await until(() => st.ui === true, 3000, 'shown again');
        send({ cmd: 'speed', kmh: 40 });
        await until(() => st.moving === true, 3000, 'moving in the status');
        await wait(1200);
        assert.ok(st.ui === true && st.uiWanted === true, 'still shown while moving');
        errors = [];
        send({ cmd: 'ui', on: false });
        await until(() => st.ui === false, 3000, 'hidden by the app while moving');
        send({ cmd: 'ui', on: true });
        await until(() => st.ui === true, 3000, 'shown while moving');
        assert.ok(!errors.length, 'not refused while moving: ' + errors.join('; '));
        send({ cmd: 'speed', kmh: 0 });
        await until(() => st.moving === false, 3000, 'parked');
        send({ cmd: 'ui', on: false });
        await until(() => st.ui === false && st.uiWanted === false, 3000, 'off');
        assert.ok(!logged().some((l) => /^vizualyse_steam /.test(l)), 'no game client');
        console.log('ok   the tool: the List corner sends {"ev":"list"} and hides it; kept while moving, shown when asked while moving; off');
    } finally {
        if (sock) sock.destroy();
        tool.kill('SIGTERM');
        await wait(400);
    }
}
