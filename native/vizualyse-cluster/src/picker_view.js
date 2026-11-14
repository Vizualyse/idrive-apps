// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The theme picker's look: its layout, what it draws for a model and what a
 * touch at x, y hits. Pure (no I/O): picker.js feeds it the tool's state and
 * puts the picture on the central screen; test/picker_test.js draws it to a
 * PNG.
 *
 * The picture fills mgu-render's app area (AREA, 1790x638 at +108+82 of the
 * screen: the HMI's title bar and its left strip with the back arrow stay
 * the HMI's). Touch targets are 50 px or more:
 *
 *   +--------------------------------------------+  +-------+-------+
 *   |                                            |  | tile  | tile  |   the eight families:
 *   |   the chosen theme, large (HERO)           |  +-------+-------+   tap to preview one
 *   |   < and > (or a swipe): the next family     |  |  ...  |  ...  |
 *   |                                            |  +-------+-------+
 *   +--------------------------------------------+  |       |       |
 *   Title                       [Sport | Comfort]   +-------+-------+
 *   what the cluster shows now                      |       |       |
 *   [Use this theme] [Try on the cluster] [Auto|Sport|Comfort]  [Turn themes off]
 *
 * The model (picker.js): families [{ family, title, sport, comfort }] (the
 * theme ids, null where a family lacks that mode), sel (an index), look
 * ('sport' | 'comfort': which of the two the previews show), enabled,
 * inUse (the family on the cluster), mode ('auto' | 'sport' | 'comfort'),
 * trying ({ family, id, left } or null), canTry, line (the status line),
 * pressed (a target id or null).
 */
'use strict';
const { measure, fit } = require('./ui_draw.js');

const AREA = { w: 1790, h: 638 };
const HERO = { x: 24, y: 24, w: 1120, h: 420 };
const TILE = { x: 1168, y: 24, w: 291, h: 118, gx: 16, gy: 12, cols: 2 };
const THUMB = { w: TILE.w, h: TILE.h };
const FONTS = { f20: { size: 20, weight: 500 }, f24: { size: 24, weight: 600 }, f36: { size: 36, weight: 600 } };
const C = { bg: 0x0b0e12, panel: 0x1a1f27, panelHi: 0x2a323e, text: 0xf1f4f8, dim: 0x8d97a6, accent: 0x2f7df6, warn: 0xf2a33a, black: 0x000000 };
const ROW = { y: 548, h: 78 };

function title(f) { return String(f.title || f.family).replace(/\s*·.*$/, ''); }

/* every touch target: { id, x, y, w, h, on } (on: it does something now) */
function layout(m) {
    const t = [];
    const fams = m.families || [];
    fams.forEach((f, i) => {
        const col = i % TILE.cols, row = Math.floor(i / TILE.cols);
        t.push({ id: 'tile:' + i, x: TILE.x + col * (TILE.w + TILE.gx), y: TILE.y + row * (TILE.h + TILE.gy), w: TILE.w, h: TILE.h, on: true });
    });
    t.push({ id: 'prev', x: HERO.x, y: HERO.y + HERO.h / 2 - 60, w: 90, h: 120, on: fams.length > 1 });
    t.push({ id: 'next', x: HERO.x + HERO.w - 90, y: HERO.y + HERO.h / 2 - 60, w: 90, h: 120, on: fams.length > 1 });
    t.push({ id: 'hero', x: HERO.x, y: HERO.y, w: HERO.w, h: HERO.h, on: false });
    const f = fams[m.sel];
    t.push({ id: 'look:sport', x: 836, y: 454, w: 150, h: 54, on: !!(f && f.sport) });
    t.push({ id: 'look:comfort', x: 994, y: 454, w: 150, h: 54, on: !!(f && f.comfort) });
    const inUse = m.enabled && f && m.inUse === f.family && !m.trying;
    t.push({ id: 'use', x: 24, y: ROW.y, w: 290, h: ROW.h, on: !!f && !inUse });
    t.push({ id: 'try', x: 330, y: ROW.y, w: 290, h: ROW.h, on: !!f && !!m.canTry && !m.trying });
    ['auto', 'sport', 'comfort'].forEach((k, i) => t.push({ id: 'mode:' + k, x: 636 + Math.round(i * 508 / 3), y: ROW.y, w: Math.round(508 / 3), h: ROW.h, on: m.mode !== k }));
    t.push({ id: 'off', x: TILE.x, y: ROW.y, w: TILE.w * 2 + TILE.gx, h: ROW.h, on: !!m.enabled });
    return t;
}

/* the target at x, y (app area pixels), or null; 'hero' for a swipe's start */
function hit(m, x, y) {
    const t = layout(m).filter((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
    return t.length ? t[0].id : null;
}

function byId(m) { const o = {}; layout(m).forEach((r) => { o[r.id] = r; }); return o; }

/* a button: filled (primary) or a panel; two lines when sub is given */
function button(cv, F, r, label, sub, style, pressed) {
    const fill = style === 'primary' ? C.accent : style === 'inert' ? C.bg : C.panel;
    cv.rrect(r.x, r.y, r.w, r.h, 12, fill);
    if (style === 'inert') cv.ring(r.x, r.y, r.w, r.h, 12, 2, C.panel);
    if (pressed) cv.rrect(r.x, r.y, r.w, r.h, 12, 0xffffff, 0.16);
    const col = style === 'inert' ? C.dim : C.text;
    const cx = r.x + r.w / 2;
    if (sub) {
        const top = r.y + (r.h - 58) / 2;
        cv.text(F.f24, fit(F.f24, label, r.w - 20), cx, top, col, 'center');
        cv.text(F.f20, fit(F.f20, sub, r.w - 20), cx, top + 32, style === 'primary' ? 0xdce8ff : C.dim, 'center');
    } else {
        cv.text(F.f24, fit(F.f24, label, r.w - 20), cx, r.y + (r.h - F.f24.lineH) / 2, col, 'center');
    }
}

/* a row of segments: the chosen one filled */
function segments(cv, F, rs, labels, subs, chosen, pressed) {
    const x0 = rs[0].x, y = rs[0].y, w = rs[rs.length - 1].x + rs[rs.length - 1].w - x0, h = rs[0].h;
    cv.rrect(x0, y, w, h, 12, C.panel);
    rs.forEach((r, i) => {
        if (i === chosen) cv.rrect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 9, C.accent);
        else if (pressed === i) cv.rrect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 9, 0xffffff, 0.12);
        const cx = r.x + r.w / 2;
        if (subs) {
            const top = y + (h - 58) / 2;
            cv.text(F.f24, labels[i], cx, top, C.text, 'center');
            cv.text(F.f20, subs[i], cx, top + 32, i === chosen ? 0xdce8ff : C.dim, 'center');
        } else {
            cv.text(F.f24, labels[i], cx, y + (h - F.f24.lineH) / 2, i === chosen ? C.text : C.dim, 'center');
        }
    });
}

/* a small label on a dark pill */
function badge(cv, F, x, y, label, colour) {
    const w = measure(F.f20, label) + 24;
    cv.rrect(x, y, w, 32, 16, colour || C.accent);
    cv.text(F.f20, label, x + 12, y + 3, C.text);
    return w;
}

/* the chevron of the prev / next buttons */
function chevron(cv, cx, cy, dir, pressed) {
    cv.rrect(cx - 28, cy - 28, 56, 56, 28, C.black, pressed ? 0.75 : 0.5);
    for (let k = -1; k <= 1; k += 2) {
        for (let s = 0; s <= 14; s++) {
            const x = cx + dir * (6 - s * 0.85), y = cy + k * s;
            cv.rrect(x - 2.5, y - 2.5, 5, 5, 2.5, C.text);
        }
    }
}

/* the whole picture for a model; assets: fonts { f20, f24, f36 }, hero(id),
 * thumb(id) (RGBA pictures, or null when missing) */
function render(cv, m, assets) {
    const F = assets.fonts, T = byId(m), fams = m.families || [], f = fams[m.sel];
    const look = (fam) => fam ? (m.look === 'comfort' ? fam.comfort || fam.sport : fam.sport || fam.comfort) : null;
    cv.fill(0, 0, AREA.w, AREA.h, C.bg);

    /* the tiles */
    fams.forEach((fam, i) => {
        const r = T['tile:' + i], img = assets.thumb(look(fam));
        if (img) cv.image(img, r.x, r.y, 10); else cv.rrect(r.x, r.y, r.w, r.h, 10, C.panel);
        cv.fade(r.x + 1, r.y + r.h - 44, r.w - 2, 43, C.black, 0, 0.85);
        cv.text(F.f20, fit(F.f20, title(fam), r.w - 24), r.x + 12, r.y + r.h - 32, C.text);
        if (m.enabled && m.inUse === fam.family) {
            const bw = measure(F.f20, 'IN USE') + 16;
            cv.rrect(r.x + r.w - bw - 8, r.y + 8, bw, 28, 14, C.accent);
            cv.text(F.f20, 'IN USE', r.x + r.w - bw / 2 - 8, r.y + 9, C.text, 'center');
        }
        if (i === m.sel) cv.ring(r.x - 4, r.y - 4, r.w + 8, r.h + 8, 13, 3, C.text);
        if (m.pressed === 'tile:' + i) cv.rrect(r.x, r.y, r.w, r.h, 10, 0xffffff, 0.16);
    });

    /* the chosen theme, large */
    const hero = f ? assets.hero(look(f)) : null;
    if (hero) cv.image(hero, HERO.x, HERO.y, 14); else cv.rrect(HERO.x, HERO.y, HERO.w, HERO.h, 14, C.panel);
    if (m.trying && f && m.trying.family === f.family) badge(cv, F, HERO.x + 16, HERO.y + 16, 'ON THE CLUSTER NOW (TRY)', C.warn);
    else if (m.enabled && f && m.inUse === f.family) badge(cv, F, HERO.x + 16, HERO.y + 16, 'ON THE CLUSTER');
    if (T.prev.on) {
        chevron(cv, HERO.x + 46, HERO.y + HERO.h / 2, -1, m.pressed === 'prev');
        chevron(cv, HERO.x + HERO.w - 46, HERO.y + HERO.h / 2, 1, m.pressed === 'next');
    }

    /* its name, Sport or Comfort, the status line */
    if (f) cv.text(F.f36, fit(F.f36, title(f), 680), 24, 456, C.text);
    const looks = [T['look:sport'], T['look:comfort']];
    const lookIdx = f && f.comfort && (m.look === 'comfort' || !f.sport) ? 1 : 0;
    cv.text(F.f20, 'Preview', looks[0].x - 14, looks[0].y + (looks[0].h - F.f20.lineH) / 2, C.dim, 'right');
    segments(cv, F, looks, ['Sport', 'Comfort'], null, lookIdx, m.pressed === 'look:sport' ? 0 : m.pressed === 'look:comfort' ? 1 : -1);
    if (m.line) cv.text(F.f20, fit(F.f20, m.line, 1120), 24, 510, m.lineWarn ? C.warn : C.dim);

    /* the buttons */
    const inUse = m.enabled && f && m.inUse === f.family && !m.trying;
    button(cv, F, T.use, inUse ? 'In use' : m.enabled ? 'Use this theme' : 'Turn on with this theme', inUse ? 'on the cluster' : null,
        T.use.on ? 'primary' : 'inert', m.pressed === 'use');
    const tryLabel = m.trying ? 'Trying: ' + Math.max(0, Math.ceil(m.trying.left)) + ' s' : 'Try on the cluster';
    button(cv, F, T.try, tryLabel, m.trying ? 'then back' : m.canTry ? 'for 10 s' : 'only while parked', T.try.on ? 'panel' : 'inert', m.pressed === 'try');
    const modes = ['auto', 'sport', 'comfort'];
    segments(cv, F, modes.map((k) => T['mode:' + k]), ['Auto', 'Sport', 'Comfort'], ['by drive mode', 'always', 'always'],
        modes.indexOf(m.mode), modes.map((k) => 'mode:' + k).indexOf(m.pressed));
    button(cv, F, T.off, m.enabled ? 'Turn themes off' : 'Themes are off', m.enabled ? "the car's own cluster comes back" : "the car's own cluster shows",
        m.enabled ? 'panel' : 'inert', m.pressed === 'off');
}

module.exports = { AREA, HERO, TILE, THUMB, FONTS, C, layout, hit, render, title };
