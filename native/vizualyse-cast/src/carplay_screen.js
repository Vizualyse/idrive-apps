// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * CarPlay's second screen as a source. hook111 (native/hook111, a Store tool),
 * when it is armed for the current start, gets the phone to stream its
 * instrument-cluster view next to the main CarPlay screen and hands it out as
 * Annex-B H.264 to a consumer listening on 127.0.0.1:<sink port> (6111). The
 * tool's ffmpeg is that consumer: it listens, the hook connects, asks the
 * phone for a keyframe, and the picture follows within about 0.2 s.
 *
 * What hook111 leaves in its run directory (/run/hook111, tmpfs):
 *   env          written by its arm step when it arms this start
 *   mode         off | alt | full  (alt is what streams; see re/STATUS.md)
 *   log/status   key=value lines: screen_b, b_frames, display, fell_back, ...
 *   display      written here: the size the phone should draw at (WxH@fps),
 *                read by the hook at the phone's next connection
 *   view         written here: which of the phone's cluster views it is asked
 *                to show (cluster | map | card), read the same way
 *
 * Node 8 (the head unit's): no optional chaining, no object spread.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RUN = process.env.CAST_HOOK_RUN || '/run/hook111';
/* hook111's install: its config (HOOK111_MODE= sets each start's mode) and
 * its arm step, whose `mode` command sets the mode for this start */
const VAR = process.env.CAST_HOOK_VAR || '/var/opt/hook111';
const ARM = process.env.CAST_HOOK_ARM || path.join(VAR, 'current', 'hook111-arm.sh');
const DEFAULT_PORT = 6111;
/* The modes offered: off (the hook answers the phone as stock) and alt (it
 * offers the second screen). Not full: with viewAreas the phone refused every
 * session on the car. */
const MODES = ['off', 'alt'];
/* The cluster views (the style) the phone is asked for, as hook111 names them
 * in /info's initialURL: cluster = the map with the directions card, map = the
 * map alone, card = the directions card alone. Whether the phone follows it
 * is not yet seen on the car. */
const VIEWS = ['cluster', 'map', 'card'];
const VIEW_TITLES = { cluster: 'map and directions', map: 'map only', card: 'directions only' };

/* What the phone is asked to draw for each target, and what the tool sends
 * on to cluster-render. The phone draws at `display`; ffmpeg scales to `w` x
 * `h` at `fps`, inside cluster-render's ~5500 KB/s upload (I420: w*h*1.5*fps):
 *   map: the cluster centre's visible band, 936x480 of its 1088x480 (`xband`);
 *        704x360 at 12 fps = 4.6 MB/s (the width a multiple of 4: 1 px padding
 *        each side, in the fade), scaled up by the renderer;
 *   hud: the HUD's visible band (17-83 % of 800 by 25-65 % of 480 = 528x192);
 *        the phone draws twice that, sent at the band's own size, 15 fps. */
const TARGETS = {
    /* map: calibrated on the car (2026-11-04): the cluster's soft vignette hides
     * the outer ~130 px each side of the 1088 target, so the phone draws 936x480,
     * placed at x 76-1012 (widened from 864 on request, 24 then 12 px each side, into
     * the fade): its edges fade out, nothing of it is cut off (only the
     * vignette's rounded top corners). */
    map: { display: { w: 936, h: 480, fps: 30 }, w: 704, h: 360, fps: 12, xband: [76 / 1088, 1012 / 1088] },
    hud: { display: { w: 1056, h: 384, fps: 30 }, w: 528, h: 192, fps: 15 },
};

/* The shape the phone is asked to draw: the target's own (wide), or its
 * height times 1.25 (taller) or 1.5 (tall), the same width. The phone lays its
 * view out for that shape (where the directions card goes may change: on the
 * car it sits top right at the wide shape); ffmpeg squeezes the picture back
 * into the target's band by the same factor. */
const SHAPES = { wide: 1, taller: 1.25, tall: 1.5 };
const SHAPE_TITLES = { wide: 'normal', taller: 'taller (x1.25)', tall: 'tall (x1.5)' };
/* Our own light vignette over the CarPlay picture: ffmpeg's vignette filter,
 * darkening towards the corners (angle PI/7; its default PI/5 is heavier). */
const VIGNETTE = 'vignette=angle=PI/7';

/* What the phone should draw for a target in a shape: { w, h, fps }; the
 * height even and at most 1080 (as hook111 accepts). */
function displayFor(output, shape) {
    const t = TARGETS[output];
    if (!t) return null;
    const m = SHAPES[shape] || 1;
    return { w: t.display.w, h: Math.min(1080, Math.round(t.display.h * m / 2) * 2), fps: t.display.fps };
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* key=value lines (the hook's status file, its env file) */
function readKv(f) {
    const t = readText(f);
    if (t === null) return null;
    const out = {};
    t.split('\n').forEach((line) => {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    });
    return out;
}

function displayText(d) { return d.w + 'x' + d.h + '@' + d.fps; }

/* The mode hook111 starts in: the last HOOK111_MODE= line of its config,
 * off without one (as its arm step reads it). */
function savedMode(varDir) {
    const t = readText(path.join(varDir || VAR, 'config')) || '';
    const m = t.split('\n').map((l) => l.trim()).filter((l) => /^HOOK111_MODE=(off|alt|full)$/.test(l)).pop();
    return m ? m.slice('HOOK111_MODE='.length) : 'off';
}

/* Turn the second screen on (alt) or off, now and for later starts: saved as
 * HOOK111_MODE in hook111's config (its other lines kept), and, when the hook
 * is armed this start, set through its arm step's `mode` (the hook reads it at
 * the phone's next SETUP). Returns { mode, now, note }: now is false when it
 * only applies from the next start. Throws with the reason when it can't. */
function setMode(mode, o) {
    o = o || {};
    const run = o.run || RUN, varDir = o.varDir || VAR, arm = o.arm || ARM;
    if (MODES.indexOf(mode) < 0) throw new Error('mode is off or alt');
    if (!fs.existsSync(arm)) throw new Error('hook111 is not installed (CarPlay cluster map, in the Store)');

    const f = path.join(varDir, 'config');
    const kept = (readText(f) || '').split('\n').filter((l) => l.trim() && !/^\s*HOOK111_MODE=/.test(l));
    const tmp = f + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, kept.concat('HOOK111_MODE=' + mode).join('\n') + '\n', { mode: 0o644 });
    fs.renameSync(tmp, f);

    const st = state(run);
    if (!st.armed) return { mode: mode, now: false, note: 'from the next start (hook111 is not armed this start)' };
    if (st.mode !== mode) {
        require('child_process').execFileSync('sh', [arm, 'mode', mode], { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const now = (readText(path.join(run, 'mode')) || '').trim() === mode;
    if (!now) return { mode: mode, now: false, note: 'from the next start (the arm step did not set it for this one)' };
    if (mode === 'alt' && st.fellBack) return { mode: mode, now: false, note: 'from the next start (hook111 fell back to off for this one)' };
    return { mode: mode, now: true, note: 'from the phone\'s next connection' };
}

/* Where hook111 stands this start. */
function state(run) {
    run = run || RUN;
    const env = readKv(path.join(run, 'env'));
    const mode = (readText(path.join(run, 'mode')) || '').trim() || null;
    const st = readKv(path.join(run, 'log', 'status')) || {};
    const fellBack = st.fell_back === '1' || fs.existsSync(path.join(run, 'log', 'fallback'));
    const port = env && /^\d{1,5}$/.test(env.HOOK111_SINK_PORT || '') ? Number(env.HOOK111_SINK_PORT) : DEFAULT_PORT;
    const armed = !!env;
    const ready = armed && (mode === 'alt' || mode === 'full') && !fellBack;
    let why = null;
    if (!armed) why = 'hook111 is not armed this start';
    else if (fellBack) why = 'hook111 fell back to off: the phone refused the second screen';
    else if (!ready) why = 'hook111 is in mode ' + (mode || 'off') + ' (alt streams the second screen)';
    return {
        armed: armed, mode: mode, ready: ready, why: why, port: port, fellBack: fellBack,
        streaming: st.screen_b === 'up',
        frames: Number(st.b_frames) || 0,
        display: st.display || null,                       /* what the phone was last offered */
        wanted: (readText(path.join(run, 'display')) || '').trim() || null,
        view: st.view === 'default' ? 'cluster' : st.view || null,   /* the view last offered */
        viewWanted: (readText(path.join(run, 'view')) || '').trim() || null,
    };
}

/* Ask for the target's resolution: the hook offers it at the phone's next
 * connection. Returns { wanted, pending } (pending: the phone is still on
 * another size, so the picture is scaled until it reconnects), or null when
 * hook111 isn't there to read it. */
function wantDisplay(output, run, shape) {
    run = run || RUN;
    const d = displayFor(output, shape);
    if (!d || !fs.existsSync(run)) return null;
    const want = displayText(d), f = path.join(run, 'display');
    if ((readText(f) || '').trim() !== want) {
        const tmp = f + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, want + '\n', { mode: 0o644 });
        fs.renameSync(tmp, f);
    }
    const cur = state(run).display;
    return { wanted: want, pending: !!cur && cur !== want };
}

/* Ask for a cluster view: the hook offers it at the phone's next connection.
 * Returns { wanted, pending } (pending: the phone was last offered another),
 * or null when hook111's run directory isn't there (not armed this start).
 * Throws on a view that isn't one of VIEWS. */
function wantView(view, run) {
    run = run || RUN;
    if (VIEWS.indexOf(view) < 0) throw new Error('view is ' + VIEWS.join(', '));
    if (!fs.existsSync(run)) return null;
    const f = path.join(run, 'view');
    if ((readText(f) || '').trim() !== view) {
        const tmp = f + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, view + '\n', { mode: 0o644 });
        fs.renameSync(tmp, f);
    }
    const cur = state(run).view;
    return { wanted: view, pending: !!cur && cur !== view };
}

/* ffmpeg's input: listen for the hook's sink, read raw H.264 starting at
 * once. A small probe (32 KB, no analysis) gives the first frame within a
 * second of the stream starting; default probing held it back 3 s. Not
 * `-fflags nobuffer`: with raw H.264 into the fps filter it drops every frame
 * (ffmpeg 7.0.2, test/carplay_test.js). */
function inputArgs(port) {
    return ['-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
        '-f', 'h264', '-i', 'tcp://127.0.0.1:' + (port || DEFAULT_PORT) + '?listen=1'];
}

/* ffmpeg's video output for a target, I420 on stdout at the target's rate.
 * The wide shape: whatever size the phone sends, fitted into w x h (aspect
 * kept, padded). A taller shape: scaled to exactly w x h, which squeezes the
 * phone's taller picture back by its factor (while the phone is still on the
 * wide size, it is that size's own shape: no squeeze). look: { shape,
 * vignette }. */
function outputArgs(output, look) {
    look = look || {};
    const t = TARGETS[output];
    const scale = (SHAPES[look.shape] || 1) !== 1
        ? 'scale=' + t.w + ':' + t.h + ':flags=bilinear,setsar=1'
        : 'scale=' + t.w + ':' + t.h + ':force_original_aspect_ratio=decrease:flags=bilinear,pad=' + t.w + ':' + t.h + ':-1:-1';
    return ['-map', '0:v:0', '-vf', scale + ',fps=' + t.fps + (look.vignette ? ',' + VIGNETTE : '') + ',format=yuv420p',
        '-f', 'rawvideo', 'pipe:1'];
}

/* The switch's state for the pages: installed, on (the saved mode is alt),
 * and when what is saved differs from this start, from when it applies. */
function switchState(o) {
    o = o || {};
    const run = o.run || RUN, varDir = o.varDir || VAR, arm = o.arm || ARM;
    if (!fs.existsSync(arm)) return { installed: false, on: false, pending: null };
    const saved = savedMode(varDir), st = state(run);
    const nowMode = st.armed && !st.fellBack ? (st.mode || 'off') : 'off';
    let pending = null;
    if ((saved === 'alt') !== (nowMode === 'alt')) pending = 'from the next start';
    else if (saved === 'alt' && !st.streaming) pending = 'from the phone\'s next connection';
    return { installed: true, on: saved === 'alt', saved: saved, pending: pending };
}

module.exports = { TARGETS, RUN, VAR, ARM, MODES, VIEWS, VIEW_TITLES, SHAPES, SHAPE_TITLES, VIGNETTE, DEFAULT_PORT, state, savedMode, setMode, switchState, displayFor, wantDisplay, wantView, inputArgs, outputArgs, readKv, displayText };
