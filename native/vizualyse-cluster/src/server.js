// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-cluster: whole-cluster themes on the instrument cluster through
 * cluster-render's panel target (THEMES.md). Root systemd service, Node 8.
 *
 * - Settings in STATE_DIR/settings.json: enabled, theme, source ('car' or
 *   'demo'), bench (the bench unit: demo allowed without a speed reading).
 * - The source: 'car' takes the signals the iDrive app sends
 *   ({"cmd":"signals", ...}); a signal it has not sent is null and a theme
 *   shows it as --. 'demo' is the bench simulation (sim.js): refused, and
 *   switched back to 'car', whenever the car moves or its speed is unknown
 *   (unless bench is set by hand on a bench unit).
 * - The control socket (control.js) for the iDrive app: enable, disable,
 *   theme {id}, source {source}, signals {...}, speed {kmh}.
 * - 25 ticks a second while a theme runs: only changed uniforms go.
 * - The picker (picker.js): every theme's preview on the central screen,
 *   chosen by touch, while the iDrive app asks ({"cmd":"picker","on":true})
 *   and the car stands still; {"cmd":"try","id":..} shows a theme on the
 *   cluster for TRY_MS while parked (with the bench drive), then what was
 *   there before.
 *
 * No phone page: the iDrive app (vizualyse_cluster) drives the tool.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ClusterRender } = require('./cluster_render_client.js');
const { ThemeRuntime } = require('./theme_runtime.js');
const { startControl } = require('./control.js');
const { Picker } = require('./picker.js');
const sim = require('./sim.js');

const HERE = __dirname;
const STATE_DIR = process.env.CLUSTER_STATE || '/var/opt/vizualyse-cluster/state';
const RENDER_SOCKET = process.env.CLUSTER_RENDER_SOCKET || undefined;
const TICK_MS = 40;
const MAX_KMH = 3;
const SIGNAL_TTL_MS = 2000;
const TRY_MS = Number(process.env.CLUSTER_TRY_MS) || 10000;
/* the picker: mgu-render's client, and the touch reader's python and source */
const RENDER_CLIENT = process.env.CLUSTER_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const PYTHON = process.env.CLUSTER_PYTHON || '/var/opt/mgu-python/current/bin/python3';
const TOUCH_IFACE = process.env.CLUSTER_TOUCH_IFACE || 'vlan73';
const TOUCH_SRC = process.env.CLUSTER_TOUCH_SRC || '160.48.199.115';
const TOUCH_FILE = process.env.CLUSTER_TOUCH_FILE || '';
const log = (s) => console.log(new Date().toISOString() + ' ' + s);

function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d, 0o700); } }
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj) {
    mkdirp(path.dirname(f));
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
}

const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
/* theme: a family (its Sport and Comfort themes share it); mode: 'auto'
 * (the car's drive mode picks Sport or Comfort), 'sport' or 'comfort' */
/* cover: black over the car's own strip under the theme (its readings hidden; its warning lights still show) */
const settings = Object.assign({ enabled: false, theme: 'g20i1', mode: 'auto', source: 'car', bench: false, cover: false }, readJson(SETTINGS_FILE));
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* ---- the car's signals (from the app) ---- */
const car = { values: {}, at: {}, kmh: null, kmhAt: 0 };
function moving() { return car.kmh === null || Date.now() - car.kmhAt > 10000 ? null : car.kmh > MAX_KMH; }
function demoAllowed() { const m = moving(); return settings.bench ? m !== true : m === false; }
function setSignals(c) {
    const now = Date.now();
    Object.keys(c).forEach((k) => {
        if (k === 'cmd') return;
        const v = c[k];
        if (v === null || typeof v === 'number' || typeof v === 'string' || Array.isArray(v)) { car.values[k] = v; car.at[k] = now; }
    });
    if (typeof c.kmh === 'number' && isFinite(c.kmh)) { setSpeed(c.kmh); car.kmhFromSignals = true; }
}
function setSpeed(kmh) {
    if (typeof kmh !== 'number' || !isFinite(kmh)) return;
    car.kmh = kmh; car.kmhAt = Date.now();
    if (settings.source === 'demo' && !demoAllowed()) { settings.source = 'car'; saveSettings(); log('source: demo stopped (the car is moving)'); }
    if (moving() === true) {
        if (trial) { log('try: ended (the car is moving)'); endTrial(true); }
        if (picker && picker.shown()) picker.hide('the car is moving');
    }
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function carSignals() {
    const now = Date.now(), out = { source: 'car' };
    Object.keys(car.values).forEach((k) => { out[k] = now - car.at[k] < SIGNAL_TTL_MS ? car.values[k] : null; });
    /* the head unit's own clock, unless the app sends the car's */
    if (out.clock == null) { const d = new Date(); out.clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
    return out;
}

/* ---- Sport or Comfort ---- */
function mode() {
    if (settings.mode === 'sport' || settings.mode === 'comfort') return settings.mode;
    if (settings.source === 'demo') return 'sport';
    const dm = car.values.driveMode;
    if (typeof dm === 'string' && Date.now() - car.at.driveMode < 10000) return /SPORT/i.test(dm) ? 'sport' : 'comfort';
    return 'comfort';   /* the car starts in Comfort */
}
/* the theme of the chosen family for the mode; the family's other one if it has no such mode */
function variant() {
    let list = [];
    try { list = runtime.list(); } catch (e) { /* none */ }
    const fam = list.filter((x) => x.family === settings.theme || x.id === settings.theme);
    const m = mode();
    const pick = fam.filter((x) => x.mode === m)[0] || fam.filter((x) => x.id === settings.theme)[0] || fam[0];
    return pick ? pick.id : settings.theme;
}

/* ---- the cluster ---- */
const cr = new ClusterRender('vizualyse-cluster', RENDER_SOCKET);
const runtime = new ThemeRuntime(cr, HERE, log);
runtime.cover = !!settings.cover;
let lastError = null, layerStates = {}, target = null, started = 0, last = 0;
cr.on('layer', (ref, state, reason) => { layerStates[ref] = state; if (state === 'error') log('render: layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')); });
cr.on('target', (name, state, holder, reason) => { if (name === 'panel') { target = state; log('render: panel ' + state + (reason ? ' (' + reason + ')' : '')); } });
cr.on('refused', (op, ref, reason) => { lastError = op + ' refused: ' + reason; log('render: ' + lastError); });
cr.on('budget', (cap, max, reason) => log('render: budget ' + cap + '/' + max + ' KB/s' + (reason ? ' (' + reason + ')' : '')));

let switchedAt = 0;
/* the chosen theme on the cluster; one already there stays (force: start it again) */
function show(force) {
    endTrial(false);
    if (!settings.enabled) return 'off';
    const id = variant();
    if (!force && runtime.theme && runtime.theme.id === id) return null;
    try { runtime.start(id); started = Date.now(); last = 0; switchedAt = started; lastError = null; return null; }
    catch (e) { lastError = e.message; log('theme: ' + e.message); return e.message; }
}
function hide(why) { if (runtime.theme) { runtime.stop(); layerStates = {}; log('hidden (' + why + ')'); } }

/* ---- a try: one theme on the cluster for TRY_MS, parked, then back ---- */
let trial = null;
function themeById(id) {
    let list = [];
    try { list = runtime.list(); } catch (e) { /* none */ }
    return list.filter((x) => x.id === id)[0] || null;
}
function tryTheme(id) {
    const t = /^[a-z0-9]+$/.test(id || '') ? themeById(id) : null;
    if (!t) return 'no theme ' + id;
    if (!demoAllowed()) return 'only while parked';
    endTrial(false);
    try { runtime.start(t.id); } catch (e) { lastError = e.message; log('try: ' + e.message); return e.message; }
    started = Date.now(); last = 0; switchedAt = started; lastError = null;
    trial = { id: t.id, family: t.family, title: t.title, until: started + TRY_MS,
        timer: setTimeout(() => { log('try: over'); endTrial(true); }, TRY_MS) };
    log('try: ' + t.id + ' for ' + TRY_MS / 1000 + ' s');
    return null;
}
/* restore: what showed before (the chosen theme, or nothing) */
function endTrial(restore) {
    if (!trial) return;
    clearTimeout(trial.timer);
    trial = null;
    if (!restore) return;
    if (settings.enabled) show(); else hide('the try is over');
    if (control) control.broadcast();
    if (picker) picker.refresh();
}

const timer = setInterval(() => {
    if (!runtime.theme) return;
    const now = Date.now();
    /* the drive mode changed: the family's other theme (at most every 3 s:
     * each switch sends the new theme's textures) */
    if (!trial && now - switchedAt > 3000 && variant() !== runtime.theme.id) { log('mode: ' + mode()); show(); return; }
    const t = (now - started) / 1000;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const sig = (trial || settings.source === 'demo') && demoAllowed() ? Object.assign({ source: 'demo' }, sim.at(t, runtime.theme.mode)) : carSignals();
    runtime.tick(sig, dt, t);
}, TICK_MS);

function status() {
    const themes = (() => { try { return runtime.list(); } catch (e) { return []; } })();
    return { enabled: settings.enabled, theme: settings.theme, mode: settings.mode, cover: !!settings.cover, showing: runtime.theme ? runtime.theme.id : null,
        source: settings.source, demo: settings.source === 'demo' && demoAllowed(), bench: settings.bench, panel: target,
        moving: moving(), speed: car.kmh, themes: themes.map((x) => ({ id: x.id, title: x.title, family: x.family, mode: x.mode })),
        signals: Object.keys(car.values).sort(), error: lastError, look: mode(),
        picker: picker.shown(), trying: trying(), canTry: demoAllowed() };
}

function trying() { return trial ? { id: trial.id, family: trial.family, left: Math.max(0, (trial.until - Date.now()) / 1000) } : null; }

/* ---- the picker on the central screen ---- */
function familyTitle(fam) {
    let list = [];
    try { list = runtime.list(); } catch (e) { /* none */ }
    const t = list.filter((x) => x.family === fam && x.mode !== 'comfort')[0] || list.filter((x) => x.family === fam)[0];
    return t ? String(t.title).replace(/\s*·.*$/, '') : fam;
}
function pickerLine() {
    if (trial) {
        return { text: 'Trying ' + String(trial.title).replace(/\s*·\s*/, ', ') + ' on the cluster, then back to ' +
            (settings.enabled ? familyTitle(settings.theme) : "the car's own cluster") };
    }
    if (!settings.enabled) return { text: "Themes are off: the car's own cluster shows" };
    if (lastError) return { text: 'The cluster: ' + lastError, warn: true };
    const how = settings.mode === 'auto' ? 'Sport or Comfort by the drive mode' : 'always ' + settings.mode;
    return { text: 'On the cluster: ' + familyTitle(settings.theme) + ', ' + how };
}
const picker = new Picker({
    dir: HERE, log: log, clientPath: RENDER_CLIENT,
    touch: { python: PYTHON, iface: TOUCH_IFACE, src: TOUCH_SRC, file: TOUCH_FILE,
        cmd: process.env.CLUSTER_TOUCH_CMD ? JSON.parse(process.env.CLUSTER_TOUCH_CMD) : null },
    state: () => {
        const s = status(), line = pickerLine();
        return { themes: s.themes, enabled: s.enabled, theme: s.theme, look: s.look, mode: s.mode,
            trying: s.trying, canTry: s.canTry, line: line.text, lineWarn: !!line.warn };
    },
    actions: {
        use: (fam) => command({ cmd: 'use', id: fam }),
        try: (id) => tryTheme(id),
        mode: (m) => command({ cmd: 'mode', mode: m }),
        off: () => command({ cmd: 'disable' }),
    },
});
picker.on('change', () => { if (control) control.broadcast(); });
/* the try's countdown and what the app changed, once a second */
const pickerTimer = setInterval(() => { if (picker.shown()) picker.refresh(); }, 1000);

function command(c) {
    if (c.cmd === 'speed') {
        /* the app's speed, once a second: the parked gate, and the theme's
         * speed until the app sends it with the other readings */
        setSpeed(c.kmh);
        if (typeof c.kmh === 'number' && isFinite(c.kmh) && !(Date.now() - (car.at.kmh || 0) < SIGNAL_TTL_MS && car.kmhFromSignals)) {
            car.values.kmh = c.kmh; car.at.kmh = Date.now(); car.kmhFromSignals = false;
        }
        return null;
    }
    if (c.cmd === 'signals') { setSignals(c); return null; }
    if (c.cmd === 'enable') { settings.enabled = true; saveSettings(); return show(); }
    if (c.cmd === 'disable') { endTrial(false); settings.enabled = false; saveSettings(); hide('turned off'); return null; }
    if (c.cmd === 'picker') {
        if (!c.on) { picker.hide('the app hid it'); return null; }
        if (moving() === true) return 'only while parked';
        return picker.show();
    }
    if (c.cmd === 'try') return tryTheme(c.id);
    if (c.cmd === 'theme' || c.cmd === 'use') {
        let known = [];
        try { known = runtime.list(); } catch (e) { /* none */ }
        if (!/^[a-z0-9]+$/.test(c.id || '') || !known.some((x) => x.id === c.id || x.family === c.id)) return 'no theme ' + c.id;
        settings.theme = c.id;
        /* use: this family, and on (the picker's Use) */
        if (c.cmd === 'use') settings.enabled = true;
        saveSettings();
        return (runtime.theme || c.cmd === 'use') && !(trial && c.cmd === 'theme') ? show() : null;
    }
    if (c.cmd === 'mode') {
        if (['auto', 'sport', 'comfort'].indexOf(c.mode) < 0) return 'mode is auto, sport or comfort';
        settings.mode = c.mode; saveSettings();
        return runtime.theme && !trial ? show() : null;
    }
    if (c.cmd === 'cover') {
        settings.cover = !!c.on; saveSettings();
        runtime.cover = settings.cover;
        return runtime.theme && !trial ? show(true) : null;
    }
    if (c.cmd === 'source') {
        if (c.source !== 'car' && c.source !== 'demo') return 'source is car or demo';
        if (c.source === 'demo' && !demoAllowed()) return 'the demo runs only while parked';
        settings.source = c.source; saveSettings(); return null;
    }
    return 'unknown command';
}

let control = null, stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    clearInterval(timer);
    clearInterval(pickerTimer);
    endTrial(false);
    picker.hide('the tool stops');
    hide('the tool stops');
    if (control) control.close();
    setTimeout(() => { cr.close(); process.exit(0); }, 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

cr.connect();
control = startControl({ app: 'vizualyse_cluster', status: status, command: command, log: log });
if (settings.enabled) show();
log('vizualyse-cluster: ' + (settings.enabled ? 'on, theme ' + settings.theme + ', source ' + settings.source : 'off'));
