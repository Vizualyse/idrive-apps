// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Steam's touch screen, in the touch kit (ui_kit.js): what it shows for a
 * model. Pure (no I/O): touch_screen.js feeds it the tool's state and puts
 * it on the central screen; test/touch_test.js draws it to a PNG.
 *
 * Two tabs, in the kit's frame (tabs top left, List top right, the status
 * line at the bottom):
 *
 *   Library   +------------------------------------------------------------+
 *             | (Running · 28 pictures/s)   [> Show on the screen] [# Stop] |
 *             | Slay the Spire 2                                           |
 *             | hidden: it keeps running until Stop                        |
 *             +------------------------------------------------------------+
 *             Library · page 1 of 2         Downloading Celeste · 42 %  [====    ]
 *             [<] [plate] [plate] [plate] [plate] [>]   four games a page, never scrolling
 *
 *   Settings  [Steam client                          (off) ]    +-----------+
 *             [Steam                                  (on) ]    | Phone page|
 *             (each game's own settings: tap it)                |   (QR)    |
 *                                                               +-----------+
 *
 * A game's tile opens its start menu (0.4.0; to 0.3.2 a tap played it): the
 * game's card with Play (or Show and Stop while it runs) and the back arrow
 * to the library, and its profile, which the tool keeps for it, in two tabs
 * in place of Library and Settings:
 *
 *   Picture       [shape: 16:9 | the screen's] [Picture size v] [Memory v]
 *                 [Upscaling: Off | FSR | FSR soft] [Detail] [Frames 30 | 60]
 *   How it runs   [Vulkan          (on)] [OpenGL on iris        (on)]
 *                 [Remove Steam DRM (off)] [Run without Steam    (off)]
 *                 [Reset to the defaults]
 *
 * The model (touch_screen.js): enabled, ready (the bundles), line { tone,
 * text } (the status line), right, game (null, or { appId, name, state
 * 'starting' | 'running' | 'ended', fps, gpuBuffers, note, shown }),
 * running, moving, library [{ appId, name, playable, why, engine, arch,
 * and its profile: resolution, fps, upscale, memMb, detail, vulkan,
 * vulkanDefault, vulkanCan, iris, irisCan, noSteam, steamApi, steamStub,
 * drm, noDrm }], page, open (the app id whose start menu is open, or null),
 * download (null, or { text, percent: 0..100 while downloading }),
 * resolutions [{ id, short, shape }], fpsChoices, memChoices, link, qr (the
 * link's modules, or null), client ({ on, installed, account, step, note }:
 * the Steam client setting, client.js), art (appId, 'tile' | 'thumb')
 * (optional).
 *
 * A game's picture (art.js: Steam's store picture, else its program's icon
 * on its plate), made by the tool at the exact size drawn, asked for only
 * for what is on the screen: m.art(appId, 'tile') { img, key } at TILE (a
 * library tile, its bottom darkened for the name), m.art(appId, 'thumb') at
 * THUMB (the game's card). None (not made yet, nothing to show): the plate
 * colour alone, as before. The picture goes under the tile's button, drawn
 * without its plate, so the ring and the press still show over it.
 */
'use strict';

const TABS = [['library', 'Library'], ['settings', 'Settings']];
const MENU_TABS = [['picture', 'Picture'], ['runs', 'How it runs']];
/* the body's places (body pixels: 1742 x 462) */
const W = 1742;
const CARD = { x: 0, y: 0, w: W, h: 150 };
const SHOW = { w: 380, h: 88 };
const STOP = { w: 280, h: 88 };
const LINE = { y: 166, h: 40 };
const ROW = { y: 222, h: 240 };
const PAGE = { w: 88 };
const PER_PAGE = 4;
const GAP = 16;
const TILE_W = Math.floor((W - 2 * (PAGE.w + GAP) - (PER_PAGE - 1) * GAP) / PER_PAGE);
const QR = { x: 1314, w: 428 };
/* the start menu: the back arrow beside the game's card, its two rows of choices */
const BACK = { w: 104 };
const MENU = { x: BACK.w + GAP, label: 30, ctl: 80, r1: 166, r2: 306, gap: 24 };
/* the pictures' sizes (art.js makes them at these): a library tile, the game's thumb */
const TILE = { w: TILE_W, h: ROW.h };
const THUMB = { x: 10, y: 9, w: 230, h: 132 };
/* the plates' colours, dark enough for white names; a game's is fixed by its app id */
const PLATES = [0x45215f, 0x5a2219, 0x174866, 0x5a420f, 0x1f5038, 0x175050, 0x501b3e, 0x2c3850];
const UPSCALES = [{ v: 'off', l: 'Off', s: 'bilinear' }, { v: 'fsr', l: 'FSR', s: 'sharpened' }, { v: 'fsr-soft', l: 'FSR', s: 'no sharpening' }];
const SHAPES = [{ v: '16:9', l: '16:9', s: 'bars at the sides' }, { v: 'screen', l: "The screen's shape", s: 'fills the screen' }];
const DETAILS = [{ v: 'normal', l: 'Normal', s: 'as the game sets it' }, { v: 'lite', l: 'Lite', s: 'no anti-aliasing' }, { v: 'potato', l: 'Potato', s: 'plainest, fastest' }];

function plate(appId) {
    let h = 0;
    String(appId).split('').forEach((c) => { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    return PLATES[h % PLATES.length];
}
function pages(m) { return Math.max(1, Math.ceil((m.library || []).length / PER_PAGE)); }
function pageOf(m) { return Math.max(0, Math.min(pages(m) - 1, m.page || 0)); }
/* the game whose start menu is open, or null */
function opened(m) { return m.open === null || m.open === undefined ? null : (m.library || []).filter((g) => g.appId === m.open)[0] || null; }

/* a resolution's shape: 16:9, or the screen's (2.8:1) */
function shapeOf(m, id) { const r = (m.resolutions || []).filter((x) => x.id === id)[0]; return r ? r.shape : '16:9'; }
/* 960 x 540 */
function sizeText(id) { return String(id || '').replace('x', ' × '); }
/* a game's profile in a line: on its tile and its card */
function summary(g) {
    return sizeText(g.resolution) + (g.upscale && g.upscale !== 'off' ? ' · FSR' : '') + ' · ' + (g.vulkan ? 'Vulkan' : 'OpenGL') +
        (g.detail && g.detail !== 'normal' ? ' · ' + g.detail[0].toUpperCase() + g.detail.slice(1) : '') + (g.fps && g.fps !== 30 ? ' · ' + g.fps + '/s' : '');
}

/* the running (or last) game's card */
function card(m, chipW) {
    const b = [], g = m.game;
    const live = !!(g && g.state === 'running'), starting = !!(g && g.state === 'starting');
    b.push({ id: 'card', kind: 'panel', x: CARD.x, y: CARD.y, w: CARD.w, h: CARD.h });
    const chip = live ? { text: 'Running · ' + (g.fps || 0) + ' pictures/s' + (g.gpuBuffers === false ? ' · no GPU buffers' : ''), tone: 'live' }
        : starting ? { text: 'Starting', tone: 'warn' }
            : g ? { text: 'Ended', tone: '' } : { text: 'Nothing running', tone: '' };
    /* the game's picture at the left, the words after it */
    const art = g && m.art ? m.art(g.appId, 'thumb') : null, tx = art ? THUMB.x + THUMB.w + 24 : 24;
    if (art) b.push({ id: 'gameArt', kind: 'image', x: THUMB.x, y: THUMB.y, w: THUMB.w, h: THUMB.h, r: 12, img: art.img, imgKey: art.key });
    b.push({ id: 'chip', kind: 'chip', x: tx, y: 18, w: chipW(chip.text), h: 36, text: chip.text, tone: chip.tone });
    const btnX = CARD.w - 24 - STOP.w - GAP - SHOW.w, textW = btnX - tx - 24;
    b.push({ id: 'title', kind: 'text', x: tx, y: 56, w: textW, h: 58, font: 'f44', text: g ? g.name : 'No game running' });
    const sub = live ? (g.shown ? 'On the screen' : 'Hidden: it keeps running until you stop it')
        : starting ? 'Wine, then the game: this can take a minute'
            : g ? (g.note ? 'Ended: ' + g.note : 'Ended') : 'Tap a game below: its start menu';
    b.push({ id: 'sub', kind: 'text', x: tx, y: 112, w: textW, h: 30, font: 'f20', colour: 'dim', text: sub });
    const y = Math.round((CARD.h - SHOW.h) / 2);
    b.push({ id: 'show', kind: 'button', x: btnX, y: y, w: SHOW.w, h: SHOW.h, act: true, on: live && !m.moving && !g.shown,
        style: 'primary', icon: 'play', label: 'Show on the screen' });
    b.push({ id: 'stop', kind: 'button', x: CARD.w - 24 - STOP.w, y: y, w: STOP.w, h: STOP.h, act: true, on: !!m.running,
        style: 'raised', icon: 'stop', label: 'Stop the game' });
    return b;
}

function library(m, chipW) {
    const b = card(m, chipW), n = pages(m), p = pageOf(m), games = m.library || [];
    b.push({ id: 'pageLabel', kind: 'text', x: 0, y: LINE.y, w: 560, h: LINE.h, font: 'f20', colour: 'dim',
        text: games.length ? 'Library · page ' + (p + 1) + ' of ' + n : 'Library' });
    const d = m.download;
    if (d && d.text) {
        const bar = d.percent !== null && d.percent !== undefined;
        const barW = bar ? 480 : 0, tx = 600, tw = W - tx - (bar ? barW + 24 : 0);
        b.push({ id: 'download', kind: 'text', x: tx, y: LINE.y, w: tw, h: LINE.h, font: 'f20', align: bar ? 'right' : 'left', text: d.text });
        if (bar) b.push({ id: 'progress', kind: 'progress', x: W - barW, y: LINE.y + 14, w: barW, h: 12, value: d.percent / 100 });
    }
    if (!games.length) {
        b.push({ id: 'empty', kind: 'panel', x: 0, y: ROW.y, w: W, h: ROW.h });
        b.push({ id: 'emptyText', kind: 'text', x: 40, y: ROW.y + 70, w: W - 80, h: 58, font: 'f32',
            text: m.enabled ? (m.ready ? 'No games yet' : 'Steam is installing itself on the car') : 'Steam is off' });
        b.push({ id: 'emptySub', kind: 'text', x: 40, y: ROW.y + 130, w: W - 80, h: 36, font: 'f24', colour: 'dim',
            text: m.enabled ? 'Scan the QR code in Settings with your phone: sign in to Steam and install a game there' : 'Turn it on in Settings' });
        return b;
    }
    b.push({ id: 'prev', kind: 'button', x: 0, y: ROW.y, w: PAGE.w, h: ROW.h, act: true, on: p > 0, icon: 'back' });
    b.push({ id: 'next', kind: 'button', x: W - PAGE.w, y: ROW.y, w: PAGE.w, h: ROW.h, act: true, on: p < n - 1, icon: 'fwd' });
    games.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE).forEach((g, i) => {
        const x = PAGE.w + GAP + i * (TILE_W + GAP);
        const playing = !!(m.game && m.game.state !== 'ended' && m.game.appId === g.appId);
        const art = m.art ? m.art(g.appId, 'tile') : null;
        if (art) b.push({ id: 'art:' + g.appId, kind: 'image', x: x, y: ROW.y, w: TILE_W, h: ROW.h, r: 14, img: art.img, imgKey: art.key });
        /* a tap opens its start menu (its profile, Play): any game, Steam on */
        b.push({ id: 'game:' + g.appId, kind: 'button', x: x, y: ROW.y, w: TILE_W, h: ROW.h, act: true, on: !!m.enabled, style: 'quiet', r: 14,
            under: art ? undefined : g.playable || playing ? plate(g.appId) : 'panel', label: '' });
        b.push({ id: 'name:' + g.appId, kind: 'text', x: x + 24, y: ROW.y + ROW.h - 112, w: TILE_W - 48, h: 44, font: 'f32',
            colour: g.playable || playing ? 'text' : 'dim', text: g.name });
        const sub = playing ? 'Running now' : g.why ? g.why : summary(g);
        b.push({ id: 'what:' + g.appId, kind: 'text', x: x + 24, y: ROW.y + ROW.h - 62, w: TILE_W - 48, h: 32, font: 'f20',
            colour: playing ? 'ok' : g.why ? 'dim' : 'accentInk', text: sub });
    });
    return b;
}

/* ---- a game's start menu ---- */

/* why it can't be played now (null: it can) */
function cantPlay(m, g) {
    if (!m.enabled) return 'Steam is off';
    if (!m.ready) return 'Steam is still installing itself';
    if (g.why) return g.why.replace(/^\((.*)\)$/, '$1');
    if (m.running) return 'Another game is running: stop it first';
    if (m.moving) return 'Only while parked';
    return null;
}

/* its card: the back arrow, its picture, name and profile, Play (or Show and Stop) */
function menuCard(m, g, chipW) {
    const b = [], live = !!(m.game && m.game.appId === g.appId && m.game.state !== 'ended'), why = live ? null : cantPlay(m, g);
    b.push({ id: 'close', kind: 'button', x: 0, y: 0, w: BACK.w, h: CARD.h, act: true, style: 'raised', icon: 'back' });
    const cx = MENU.x, cw = W - cx;
    b.push({ id: 'menuCard', kind: 'panel', x: cx, y: 0, w: cw, h: CARD.h });
    const art = m.art ? m.art(g.appId, 'thumb') : null, tx = cx + (art ? THUMB.x + THUMB.w + 24 : 24);
    if (art) b.push({ id: 'menuArt', kind: 'image', x: cx + THUMB.x, y: THUMB.y, w: THUMB.w, h: THUMB.h, r: 12, img: art.img, imgKey: art.key });
    const st = m.game && m.game.appId === g.appId ? m.game.state : null;
    const chip = st === 'running' ? { text: 'Running · ' + (m.game.fps || 0) + ' pictures/s', tone: 'live' } : st === 'starting' ? { text: 'Starting', tone: 'warn' }
        : why ? { text: why, tone: 'warn' } : { text: 'Ready to play', tone: 'ok' };
    const stopW = 200, stopX = W - 24 - stopW, showW = 284, showX = stopX - GAP - showW;
    const btnX = live ? showX : W - 24 - SHOW.w, textW = btnX - tx - 24, y = Math.round((CARD.h - SHOW.h) / 2);
    b.push({ id: 'menuChip', kind: 'chip', x: tx, y: 18, w: chipW(chip.text), h: 36, text: chip.text, tone: chip.tone });
    b.push({ id: 'menuTitle', kind: 'text', x: tx, y: 56, w: textW, h: 58, font: 'f44', text: g.name });
    b.push({ id: 'menuSub', kind: 'text', x: tx, y: 112, w: textW, h: 30, font: 'f20', colour: 'dim',
        text: summary(g) + (g.arch ? ' · ' + g.arch : '') + (g.engine ? ' · ' + g.engine[0].toUpperCase() + g.engine.slice(1) : '') });
    if (live) {
        b.push({ id: 'show', kind: 'button', x: showX, y: y, w: showW, h: SHOW.h, act: true, on: st === 'running' && !m.moving && !m.game.shown,
            style: 'primary', icon: 'play', label: 'Show' });
        b.push({ id: 'stop', kind: 'button', x: stopX, y: y, w: stopW, h: STOP.h, act: true, on: true, style: 'raised', icon: 'stop', label: 'Stop' });
    } else {
        b.push({ id: 'play', kind: 'button', x: btnX, y: y, w: SHOW.w, h: SHOW.h, act: true, on: !why, style: 'primary', icon: 'play', label: 'Play' });
    }
    return b;
}

function memText(mb) { return (mb / 1024).toFixed(1).replace('.0', '') + ' GB'; }

/* Picture: its shape and size, memory; upscaling, Detail, frames a second */
function menuPicture(m, g) {
    const b = [], shape = shapeOf(m, g.resolution), on = !!m.enabled, r1 = MENU.r1, r2 = MENU.r2, c = MENU.ctl, L = MENU.label;
    const sizes = (m.resolutions || []).filter((r) => r.shape === shape).map((r) => ({ v: r.id, l: r.short }));
    b.push({ id: 'shapeLabel', kind: 'text', x: 0, y: r1, w: 520, h: L, font: 'f20', colour: 'dim', text: 'The picture the game draws' });
    b.push({ id: 'p:shape', kind: 'seg', x: 0, y: r1 + L + 6, w: 520, h: c, act: true, on: on, value: shape, options: SHAPES });
    b.push({ id: 'p:resolution', kind: 'dropdown', x: 544, y: r1 + L + 6, w: 620, h: c, act: true, on: on, label: 'Picture size', value: g.resolution, options: sizes });
    b.push({ id: 'p:memMb', kind: 'dropdown', x: 1188, y: r1 + L + 6, w: W - 1188, h: c, act: true, on: on, label: 'Memory for the game (more: bigger games)',
        value: g.memMb, options: (m.memChoices || []).map((v) => ({ v: v, l: memText(v) })) });
    b.push({ id: 'upLabel', kind: 'text', x: 0, y: r2, w: 760, h: L, font: 'f20', colour: 'dim', text: 'Upscaling: the picture enlarged to the screen' });
    b.push({ id: 'p:upscale', kind: 'seg', x: 0, y: r2 + L + 6, w: 760, h: c, act: true, on: on, value: g.upscale, options: UPSCALES });
    b.push({ id: 'detailLabel', kind: 'text', x: 784, y: r2, w: 560, h: L, font: 'f20', colour: 'dim', text: 'Detail' });
    b.push({ id: 'p:detail', kind: 'seg', x: 784, y: r2 + L + 6, w: 560, h: c, act: true, on: on, value: g.detail || 'normal', options: DETAILS });
    b.push({ id: 'fpsLabel', kind: 'text', x: 1368, y: r2, w: W - 1368, h: L, font: 'f20', colour: 'dim', text: 'Frames a second' });
    b.push({ id: 'p:fps', kind: 'seg', x: 1368, y: r2 + L + 6, w: W - 1368, h: c, act: true, on: on, value: g.fps,
        options: (m.fpsChoices || [30, 60]).map((v) => ({ v: v, l: String(v) })) });
    const live = !!(m.game && m.game.appId === g.appId && m.game.state !== 'ended');
    b.push({ id: 'pictureNote', kind: 'text', x: 0, y: 428, w: W, h: 34, font: 'f20', colour: 'dim',
        text: live ? 'Upscaling and memory change the running game at once; the rest from its next start' : 'Kept for this game: every start uses them' });
    return b;
}

/* How it runs: Vulkan, the OpenGL driver, Remove Steam DRM, Run without Steam; the defaults */
function menuRuns(m, g) {
    const b = [], on = !!m.enabled, live = !!(m.game && m.game.appId === g.appId && m.game.state !== 'ended');
    const cw = Math.floor((W - MENU.gap) / 2), x2 = cw + MENU.gap, h = 96, r1 = MENU.r1, r2 = MENU.r1 + h + 16;
    const later = live ? ' (from its next start)' : '';
    b.push({ id: 'p:vulkan', kind: 'toggle', x: 0, y: r1, w: cw, h: h, act: true, on: on && (!!g.vulkanCan || !!g.vulkan), value: !!g.vulkan,
        label: 'Vulkan' + (g.vulkan === g.vulkanDefault ? ' (the default)' : ''),
        sub: !g.vulkanCan && !g.vulkan ? 'no Vulkan driver on this unit yet' : g.vulkan ? 'on: Direct3D through DXVK' + later : 'off: OpenGL (WineD3D)' + later });
    b.push({ id: 'p:iris', kind: 'toggle', x: x2, y: r1, w: cw, h: h, act: true, on: on && !g.vulkan && (!!g.irisCan || !!g.iris), value: !!g.iris,
        label: 'OpenGL on iris',
        sub: g.vulkan ? 'used only with Vulkan off' : !g.irisCan ? 'no iris on this unit' : g.iris ? "on: Mesa's newer Intel driver" + later : "off: the car's own i965" + later });
    const drm = g.drm || {}, variant = drm.variant ? ' ' + drm.variant : '';
    const drmOk = !!(g.steamStub && drm.supported);
    b.push({ id: 'p:noDrm', kind: 'toggle', x: 0, y: r2, w: cw, h: h, act: true, on: on && drmOk && !live, value: !!g.noDrm,
        label: 'Remove Steam DRM',
        sub: !g.steamStub ? 'no Steam DRM wrapper on its program' : !drmOk ? 'SteamStub' + variant + ": can't be taken off yet"
            : live ? 'not while it runs' : g.noDrm ? 'on: SteamStub' + variant + ' taken off its program' : 'off: SteamStub' + variant + ' on: it quits without Steam' });
    const api = g.steamApi !== 0;
    b.push({ id: 'p:noSteam', kind: 'toggle', x: x2, y: r2, w: cw, h: h, act: true, on: on && api && !live, value: !!g.noSteam,
        label: 'Run without Steam',
        sub: !api ? "its program doesn't use Steam's library" : live ? 'not while it runs' : g.noSteam ? "on: gbe_fork in place of Steam's library" : "off: Steam's own library (it may want Steam)" });
    const r3 = r2 + h + 16;
    b.push({ id: 'p:reset', kind: 'button', x: 0, y: r3, w: 420, h: 462 - r3, act: true, on: on, style: 'raised', icon: 'reload', label: 'Reset to the defaults' });
    b.push({ id: 'resetNote', kind: 'text', x: 444, y: r3, w: W - 444, h: 462 - r3, font: 'f20', colour: 'dim',
        text: 'The picture, Detail, Vulkan and OpenGL back to the defaults; the DRM and Steam switches stay' });
    return b;
}

function menu(m, g, tab, chipW) {
    const b = menuCard(m, g, chipW);
    return b.concat(tab === 'runs' ? menuRuns(m, g) : menuPicture(m, g));
}

/* the Steam client toggle's line: what it means, or where it is */
function clientSub(c) {
    if (c.step) return c.step;
    if (!c.on) return 'off: games start by themselves (light). On: in Steam\'s own client, for Steam DRM (~2 GB)';
    if (c.account) return 'on: games start in Steam\'s client, signed in as ' + c.account;
    return c.note || (c.installed ? 'on: not signed in yet: turn it off and on to sign in' : 'on: not installed yet');
}

function settings(m) {
    const b = [], off = !m.enabled;
    const c = m.client || {};
    b.push({ id: 'steamLabel', kind: 'text', x: 0, y: 0, w: 1290, h: 30, font: 'f20', colour: 'dim', text: 'Steam on the car' });
    b.push({ id: 'client', kind: 'toggle', x: 0, y: 36, w: 1290, h: 96, act: true, on: !off, value: !!c.on,
        label: 'Steam client', sub: clientSub(c) });
    b.push({ id: 'enabled', kind: 'toggle', x: 0, y: 148, w: 1290, h: 96, act: true, value: !!m.enabled,
        label: 'Steam', sub: m.enabled ? 'on: games and downloads run, the phone page is open' : 'off: no game, no download, no phone page' });
    b.push({ id: 'perGame', kind: 'panel', x: 0, y: 268, w: 1290, h: 194 });
    b.push({ id: 'perGameTitle', kind: 'text', x: 24, y: 290, w: 1242, h: 44, font: 'f32', text: "Each game's own settings" });
    b.push({ id: 'perGameText', kind: 'text', x: 24, y: 344, w: 1242, h: 34, font: 'f24', colour: 'dim',
        text: 'Picture size, upscaling (FSR), memory, Detail, frames, Vulkan, Remove Steam DRM:' });
    b.push({ id: 'perGameText2', kind: 'text', x: 24, y: 384, w: 1242, h: 34, font: 'f24', colour: 'dim',
        text: 'tap the game in the Library. Its start menu keeps them for it.' });
    b.push({ id: 'qrCard', kind: 'panel', x: QR.x, y: 0, w: QR.w, h: 462 });
    b.push({ id: 'qrLabel', kind: 'text', x: QR.x + 24, y: 12, w: QR.w - 48, h: 30, font: 'f20', colour: 'dim', text: 'Phone page' });
    if (m.qr && m.link) {
        b.push({ id: 'qr', kind: 'qr', x: QR.x + (QR.w - 300) / 2, y: 48, w: 300, h: 300, matrix: m.qr });
        b.push({ id: 'link', kind: 'text', x: QR.x + 16, y: 356, w: QR.w - 32, h: 30, font: 'f20', align: 'center', text: m.link.replace(/^http:\/\//, '') });
        b.push({ id: 'qrHint', kind: 'text', x: QR.x + 16, y: 392, w: QR.w - 32, h: 30, font: 'f20', colour: 'dim', align: 'center', text: 'Scan it: sign in, install games' });
        b.push({ id: 'qrHint2', kind: 'text', x: QR.x + 16, y: 420, w: QR.w - 32, h: 30, font: 'f20', colour: 'dim', align: 'center', text: "from the phone whose hotspot the car is on" });
    } else {
        b.push({ id: 'noLink', kind: 'text', x: QR.x + 24, y: 160, w: QR.w - 48, h: 42, font: 'f24', align: 'center', text: m.enabled ? 'No phone connected' : 'Steam is off' });
        b.push({ id: 'noLink2', kind: 'text', x: QR.x + 24, y: 206, w: QR.w - 48, h: 30, font: 'f20', colour: 'dim', align: 'center',
            text: m.enabled ? "Turn on the phone's hotspot" : 'Turn it on to open the page' });
    }
    return b;
}

/* the kit's view for a model: { tabs, status, body }; chipW(text) the kit's chip width */
function view(m, ui, chipW) {
    const line = m.line || {}, g = opened(m);
    return {
        tabs: g ? MENU_TABS : TABS,
        status: { tone: line.tone || '', text: line.text || '', right: m.right || '' },
        body: g ? menu(m, g, ui.tab, chipW) : ui.tab === 'settings' ? settings(m) : library(m, chipW),
    };
}

module.exports = { TABS, MENU_TABS, PER_PAGE, TILE_W, ROW, TILE, THUMB, view, pages, pageOf, plate, shapeOf, opened, summary, cantPlay };
