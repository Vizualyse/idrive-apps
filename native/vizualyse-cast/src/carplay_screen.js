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
 * on to cluster-render. The phone draws at `display`; ffmpeg fits that into
 * `w` x `h` (aspect kept) at up to `fps`:
 *   map: the cluster centre's band, 984x480 of its 1088x480 (`xband`), sent
 *        as the phone draws it (no scaling) at up to 20 fps. That can ask for
 *        more than cluster-render's 5500 KB/s upload cap while the map moves;
 *        its governor keeps the link to the cluster within the cap (frames it
 *        can't cover go packed, then exact). On the car (2026-11-04, 936x480,
 *        parked): ~14.5 fps to the cluster, 0 budget holds, 19 packed in 15 s.
 *   hud: the HUD's visible band (17-83 % of 800 by 25-65 % of 480 = 528x192),
 *        15 fps. By default the phone draws the cluster's picture (984x480,
 *        its safe area) and it is fitted in, black either side. `alt` (the
 *        HUD's alternate mode): 1056x384, the band's own shape, no safe area.
 * `safe`: the safe area hook111 offers the phone (viewAreas), centred
 * across the width the phone draws: where it centres the car and the
 * directions card. */
const TARGETS = {
    /* map: calibrated on the car (2026-11-04): the cluster's soft vignette hides
     * the outer ~130 px each side of the 1088 target, so the phone draws 984x480,
     * placed at x 52-1036 (widened from 864 on request, 24, 12 and 24 px each side,
     * into the fade): its edges fade out (only the vignette's rounded top corners
     * cut). Safe area 340x330 at y 40: on the car, Google Maps put the car, and
     * the directions card above it, at its centre (936 wide, x 298; y 80 put
     * both 40 px lower). */
    map: { display: { w: 984, h: 480, fps: 30 }, w: 984, h: 480, fps: 20, xband: [52 / 1088, 1036 / 1088],
        safe: { w: 340, h: 330, y: 40 } },
    hud: { like: 'map', w: 528, h: 192, fps: 15,
        alt: { display: { w: 1056, h: 384, fps: 30 } } },
};

/* What the phone draws for a target: { display, safe } (safe null: none). The
 * HUD takes the map's unless alt (its alternate mode). */
function drawFor(output, alt) {
    const t = TARGETS[output];
    if (!t) return null;
    if (t.like && alt && t.alt) return { display: t.alt.display, safe: null };
    const s = t.like ? TARGETS[t.like] : t;
    return { display: s.display, safe: s.safe || null };
}

/* (0.3.5 had a shape setting, taller, and our own vignette. On
 * the car, 2026-11-04: a taller picture squeezed back looked squashed, and
 * neither shape moved Google Maps' layout; the safe area does that. Both
 * removed in 0.3.6.) */

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
        size: st.b_size || null,                           /* what the phone really sends (its SPS), hook111 0.1.3+ */
        safearea: st.safearea || null,                     /* x,y,w,h last offered, or none */
        safeWanted: (readText(path.join(run, 'safearea')) || '').trim() || null,
    };
}

/* Ask for the target's resolution: the hook offers it at the phone's next
 * connection. Returns { wanted, pending } (pending: the phone is still on
 * another size, so the picture is scaled until it reconnects), or null when
 * hook111 isn't there to read it. */
function writeIfChanged(f, text) {
    if ((readText(f) || '').trim() === text) return;
    const tmp = f + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, text + '\n', { mode: 0o644 });
    fs.renameSync(tmp, f);
}

/* The safe area for a target: { x, y, w, h } centred across the width the
 * phone draws, or null (none: the HUD's alternate mode). */
function safeAreaFor(output, alt) {
    const d = drawFor(output, alt);
    if (!d || !d.safe) return null;
    return { x: Math.floor((d.display.w - d.safe.w) / 2), y: d.safe.y, w: d.safe.w, h: d.safe.h };
}
function safeText(s) { return s ? s.x + ',' + s.y + ',' + s.w + ',' + s.h : null; }

/* Ask for the target's size (and, with centre, its safe area; without,
 * none): the hook offers them at the phone's next connection. alt: the HUD's
 * alternate mode. Returns { wanted, safearea, pending } (pending: the phone
 * is still on another size or safe area, so the picture is scaled until it
 * reconnects), or null when hook111 isn't there to read it. */
function wantDisplay(output, run, centre, alt) {
    run = run || RUN;
    const d = drawFor(output, alt);
    if (!d || !fs.existsSync(run)) return null;
    const want = displayText(d.display);
    writeIfChanged(path.join(run, 'display'), want);
    const sa = centre ? safeText(safeAreaFor(output, alt)) : null, sf = path.join(run, 'safearea');
    if (sa) writeIfChanged(sf, sa);
    else { try { fs.unlinkSync(sf); } catch (e) { /* none */ } }
    const st = state(run);
    const offeredSafe = st.safearea && st.safearea !== 'none' ? st.safearea : null;
    return { wanted: want, safearea: sa, pending: (!!st.display && st.display !== want) || (!!st.display && offeredSafe !== sa) };
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

/* ffmpeg's video output for a target: whatever size the phone sends, fitted
 * into w x h (aspect kept, padded, never squeezed), at the target's rate,
 * I420 on stdout. */
function outputArgs(output) {
    const t = TARGETS[output];
    return ['-map', '0:v:0', '-vf', 'scale=' + t.w + ':' + t.h + ':force_original_aspect_ratio=decrease:flags=bilinear,' +
        'pad=' + t.w + ':' + t.h + ':-1:-1,fps=' + t.fps + ',format=yuv420p', '-f', 'rawvideo', 'pipe:1'];
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

module.exports = { TARGETS, RUN, VAR, ARM, MODES, VIEWS, VIEW_TITLES, DEFAULT_PORT, state, savedMode, setMode, switchState, drawFor, safeAreaFor, safeText, wantDisplay, wantView, inputArgs, outputArgs, readKv, displayText };
