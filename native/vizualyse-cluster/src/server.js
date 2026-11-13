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
 *
 * No phone page yet, and no iDrive app yet (TODO.md): until then the tool
 * is driven over its control socket and settings.json on the bench.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { ClusterRender } = require('./cluster_render_client.js');
const { ThemeRuntime } = require('./theme_runtime.js');
const { startControl } = require('./control.js');
const sim = require('./sim.js');

const HERE = __dirname;
const STATE_DIR = process.env.CLUSTER_STATE || '/var/opt/vizualyse-cluster/state';
const RENDER_SOCKET = process.env.CLUSTER_RENDER_SOCKET || undefined;
const TICK_MS = 40;
const MAX_KMH = 3;
const SIGNAL_TTL_MS = 2000;
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
const settings = Object.assign({ enabled: false, theme: 'g20i1', mode: 'auto', source: 'car', bench: false }, readJson(SETTINGS_FILE));
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
    if (typeof c.kmh === 'number' && isFinite(c.kmh)) setSpeed(c.kmh);
}
function setSpeed(kmh) {
    if (typeof kmh !== 'number' || !isFinite(kmh)) return;
    car.kmh = kmh; car.kmhAt = Date.now();
    if (settings.source === 'demo' && !demoAllowed()) { settings.source = 'car'; saveSettings(); log('source: demo stopped (the car is moving)'); }
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
let lastError = null, layerStates = {}, target = null, started = 0, last = 0;
cr.on('layer', (ref, state, reason) => { layerStates[ref] = state; if (state === 'error') log('render: layer ' + ref + ' ' + state + (reason ? ': ' + reason : '')); });
cr.on('target', (name, state, holder, reason) => { if (name === 'panel') { target = state; log('render: panel ' + state + (reason ? ' (' + reason + ')' : '')); } });
cr.on('refused', (op, ref, reason) => { lastError = op + ' refused: ' + reason; log('render: ' + lastError); });
cr.on('budget', (cap, max, reason) => log('render: budget ' + cap + '/' + max + ' KB/s' + (reason ? ' (' + reason + ')' : '')));

let switchedAt = 0;
function show() {
    if (!settings.enabled) return 'off';
    const id = variant();
    try { runtime.start(id); started = Date.now(); last = 0; switchedAt = started; lastError = null; return null; }
    catch (e) { lastError = e.message; log('theme: ' + e.message); return e.message; }
}
function hide(why) { if (runtime.theme) { runtime.stop(); layerStates = {}; log('hidden (' + why + ')'); } }

const timer = setInterval(() => {
    if (!runtime.theme) return;
    const now = Date.now();
    /* the drive mode changed: the family's other theme (at most every 3 s:
     * each switch sends the new theme's textures) */
    if (now - switchedAt > 3000 && variant() !== runtime.theme.id) { log('mode: ' + mode()); show(); return; }
    const t = (now - started) / 1000;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const sig = settings.source === 'demo' && demoAllowed() ? Object.assign({ source: 'demo' }, sim.at(t, runtime.theme.mode)) : carSignals();
    runtime.tick(sig, dt, t);
}, TICK_MS);

function status() {
    const themes = (() => { try { return runtime.list(); } catch (e) { return []; } })();
    return { enabled: settings.enabled, theme: settings.theme, mode: settings.mode, showing: runtime.theme ? runtime.theme.id : null,
        source: settings.source, demo: settings.source === 'demo' && demoAllowed(), bench: settings.bench, panel: target,
        moving: moving(), speed: car.kmh, themes: themes.map((x) => ({ id: x.id, title: x.title, family: x.family, mode: x.mode })),
        signals: Object.keys(car.values).sort(), error: lastError };
}

function command(c) {
    if (c.cmd === 'speed') { setSpeed(c.kmh); return null; }
    if (c.cmd === 'signals') { setSignals(c); return null; }
    if (c.cmd === 'enable') { settings.enabled = true; saveSettings(); return show(); }
    if (c.cmd === 'disable') { settings.enabled = false; saveSettings(); hide('turned off'); return null; }
    if (c.cmd === 'theme') {
        let known = [];
        try { known = runtime.list(); } catch (e) { /* none */ }
        if (!/^[a-z0-9]+$/.test(c.id || '') || !known.some((x) => x.id === c.id || x.family === c.id)) return 'no theme ' + c.id;
        settings.theme = c.id; saveSettings();
        return runtime.theme ? show() : null;
    }
    if (c.cmd === 'mode') {
        if (['auto', 'sport', 'comfort'].indexOf(c.mode) < 0) return 'mode is auto, sport or comfort';
        settings.mode = c.mode; saveSettings();
        return runtime.theme ? show() : null;
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
