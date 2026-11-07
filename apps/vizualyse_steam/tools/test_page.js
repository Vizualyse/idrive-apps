// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against a
 * fake SDK and HMI built from the shipped uiDescription.json, talking to a
 * fake vizualyse-steam control socket (the protocol in
 * src/steam_control.js) with a scripted status. (The scaffolding is
 * vizualyse_chromium's.)
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree, the app binds every
 * button, its UUIDs are its own; with no tool the status says so and the
 * buttons are off; connected, the link as a QR PNG, a Play button per game
 * (four at most; none without a program); Play sends play, and once the game
 * draws the empty screen state opens and show goes; BACK and a pop-up hide it
 * (it keeps running), Show opens the screen state again, Stop sends stop; a
 * game ending before it draws shows its note and nothing; the download row;
 * Picture; out of memory; the speed and "only while parked"; the restart
 * note; a failed command's error; installing; on / off; a new link's QR; the
 * tool going away.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\vsteam-test-' + process.pid : path.join(os.tmpdir(), 'vsteam-' + process.pid + '.sock');
const QR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vsteam-qr-'));
process.env.STEAM_CTL_SOCKET = PIPE;
process.env.STEAM_QR_DIR = QR_DIR;

const STAGED = fs.readdirSync(ROOT).find((n) => n.startsWith('vizualyse_steam@') && !n.endsWith('.tgz'));
const PKG = path.join(ROOT, STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));
const STATE = 'ST_OnlineApps_VizualyseSteam';
const SCREEN = 'ST_OnlineApps_VizualyseSteamScreen';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function until(what, check, ms) {
    const deadline = Date.now() + (ms || 3000);
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error('timed out waiting for ' + what));
            else setTimeout(poll, 10);
        };
        poll();
    });
}

/* ---- fake HMI ----------------------------------------------------------- */
class FakeComponent extends EventEmitter {
    constructor(id, desc) {
        super();
        this.id = Number(id);
        this.text = null; this.graphic = null; this.enabled = null; this.cells = {};
        this.visible = desc && desc.properties && desc.properties.Visible ? desc.properties.Visible.value === 1 : null;
    }
    getId() { return this.id; }
    setValue(row, cell, value, type) {
        if (arguments.length === 3) { this.cells[row] = cell; return Promise.resolve(); }   /* a drop-down's cell */
        if (cell === 'Graphic') this.graphic = { value, type }; else this.text = value;
        return Promise.resolve();
    }
    setEnabled(v) { this.enabled = v; return Promise.resolve(); }
    setVisible(v) { this.visible = v; return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const byName = {};
Object.keys(UI.containers).forEach((cid) => {
    const cont = UI.containers[cid];
    byName[cont.name] = new FakeComponent(cid, cont);
    Object.keys(cont.components).forEach((id) => { byName[cont.components[id].name] = new FakeComponent(id, cont.components[id]); });
});
const handles = new Set(), destroyed = [];
const bundle = {
    createResourceHandles(files) { files.forEach((f) => { assert(fs.existsSync(f), 'handle for a missing file'); handles.add(f); }); return Promise.resolve(); },
    destroyResourceHandles(files) { files.forEach((f) => { handles.delete(f); destroyed.push(f); }); return Promise.resolve(); },
};
const rhmi = new EventEmitter();
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();
/* openState: the main state goes, the state opened comes (as the HMI does); openFails: refused */
const opened = [];
let openFails = false;
rhmi.openState = (st) => {
    if (openFails) return Promise.reject(new Error('refused'));
    opened.push(st);
    setImmediate(() => { byName[STATE].emit('visible', { visible: false }); st.emit('visible', { visible: true }); });
    return Promise.resolve();
};
rhmi.getResourceBundle = () => bundle;
rhmi.flush = () => Promise.resolve();

/* ---- fake SDK ----------------------------------------------------------- */
const logs = [];
const logger = {};
['error', 'warn', 'info', 'verbose', 'debug'].forEach((l) => { logger[l] = (m) => logs.push(l + ': ' + m); });
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this._packageJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
        this.appDescription = APP_JSON;
        this.rhmiApplication = rhmi;
        this.startReason = 'ENTRY_POINT';
        this._initialized = false;
        this._appStatusService = null;
        const d = APP_JSON.application.entryPoints[0];
        this._eps = [{ entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
            getDescription: () => d, init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }];
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    getAppId() { return 'vizualyse_steam'; }
    getEntryPoints() { return this._eps; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}
/* Vehicle2's speed, raw (km/h x 64; 65535 invalid) */
let speedRaw = 65535;
const someipBuilders = {
    buildTypedProxy(iface, instance) {
        assert.strictEqual(iface, 'de.bmw.infotainment.vehicle.Vehicle2');
        assert.strictEqual(instance, '1');
        return Promise.resolve({ init: () => Promise.resolve(), statusCarSpeed2: { getValue: () => Promise.resolve({ speedVehicleCentreOfGravity: speedRaw }) } });
    },
};
function runSource() {
    const Module = require('module');
    const load = Module._load;
    const FAKES = { 'oap-sdk/src/core/OnlineApp.js': OnlineApp, 'oap-sdk/src/logging/logging': { getSDKLogger: () => logger },
        'oap-sdk/src/someip/someipBuilders': someipBuilders };
    Module._load = function (req, parent, isMain) { return FAKES[req] || load.call(this, req, parent, isMain); };
    require(path.join(ROOT, MANIFEST.modules[0]));
}

/* ---- a fake vizualyse-steam control socket --------------------------- */
/* The tool's side of the protocol: status on connect, after every command
 * and on broadcast(); {"ev":"error"} for a command the script refuses. */
function startFakeTool(opts) {
    const clients = new Set();
    const send = (s, obj) => { try { s.write(JSON.stringify(obj) + '\n'); } catch (e) { /* gone */ } };
    const status = () => Object.assign({ ev: 'status' }, opts.status());
    const server = net.createServer((s) => {
        clients.add(s);
        s.setEncoding('utf8');
        let buf = '';
        s.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let c = null;
                try { c = JSON.parse(line); } catch (e) { send(s, { ev: 'error', error: 'bad json' }); continue; }
                const err = opts.command(c);
                if (err) send(s, { ev: 'error', error: err });
                clients.forEach((x) => send(x, status()));
            }
        });
        s.on('error', () => {});
        s.on('close', () => clients.delete(s));
        send(s, status());
    });
    if (process.platform !== 'win32') { try { fs.unlinkSync(PIPE); } catch (e) { /* none */ } }
    server.listen(PIPE);
    return {
        broadcast() { clients.forEach((x) => send(x, status())); },
        clients() { return clients.size; },
        close() { clients.forEach((x) => x.destroy()); server.close(); },
    };
}

const LINK1 = 'http://172.20.10.2:8494/?t=0123456789abcdef';
const LINK2 = 'http://172.20.10.3:8494/?t=0123456789abcdef';
const STS2 = { appId: 2868840, name: 'Slay the Spire 2', exe: 'SlayTheSpire2.exe', args: '--rendering-driver opengl3', engine: 'godot', sizeMb: 3100 };
const OTHER = { appId: 4242, name: 'Test Game', exe: 'TestGame.exe', args: '', engine: null, sizeMb: 10 };
const BASE = { enabled: true, link: LINK1, uplink: 'online', bundle: 'ready', error: null, prefixNote: null, restartNote: null,
    account: { username: 'tester', remembered: true }, download: null, library: [STS2, OTHER], game: null, running: false, shown: false,
    speed: null, moving: false, settings: { where: 'internal', resolution: '1280x720', fps: 30, memMb: 2560, sound: true, volume: 100 },
    memory: { capMb: 2560, usedMb: null, peakMb: null, note: null, oomAt: null } };
let st = Object.assign({}, BASE);
const received = [];
let refuse = null;
let tool = null;
const GAME = (state, extra) => Object.assign({ appId: STS2.appId, name: STS2.name, state: state, title: null, since: new Date().toISOString(),
    pictures: state === 'running' ? 300 : 0, fps: state === 'running' ? 28 : 0, gpuBuffers: true, sinkMs: 9, buffers: { drm: 300, shm: 0 }, note: null }, extra || {});
function serve() {
    tool = startFakeTool({ status: () => st, command: (c) => {
        received.push(c);
        if (c.cmd === 'speed') return null;
        if (c.cmd === 'show') st = Object.assign({}, st, { shown: true });
        if (c.cmd === 'hide') st = Object.assign({}, st, { shown: false });
        const r = refuse; refuse = null; return r;
    } });
}
const sent = (cmd) => received.some((c) => c.cmd === cmd);
const count = (cmd) => received.filter((c) => c.cmd === cmd).length;
const BUTTONS = ['steamShow', 'steamStop', 'steamPlay1', 'steamPlay2', 'steamPlay3', 'steamPlay4', 'steamResolution', 'steamEnable'];

async function main() {
    const comps = UI.containers['1'].components;
    assert.strictEqual(UI.containers['1'].name, STATE);
    const xmlIds = (XML.match(/<component id="(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]).sort();
    const scr = UI.containers['2'];
    assert.deepStrictEqual(Object.keys(comps).concat(Object.keys(scr.components)).sort(), xmlIds, 'application.xml and uiDescription.json list the same components');
    assert.strictEqual(scr.name, SCREEN);
    assert(Object.keys(scr.components).every((id) => scr.components[id].type !== 'button' &&
        !(scr.components[id].properties.Focusable && scr.components[id].properties.Focusable.value)), 'the screen state has nothing to press');
    assert(/<container id="2" type="state" widget="LT_State_Wide">\n {8}<property id="9" value="1"\/>/.test(XML), 'the screen state\'s parent is the main state');
    assert.strictEqual(comps['21'].name, 'steamQr');
    assert(/<component id="21" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR is a scalable graphic label');
    const buttons = Object.keys(comps).filter((id) => comps[id].type === 'button').map((id) => comps[id].name).sort();
    assert.deepStrictEqual(buttons, BUTTONS.slice().sort());
    const ep = APP_JSON.application.entryPoints[0];
    assert(fs.existsSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'images', ep.icon)), 'the tile icon ships');
    const strings = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
    assert.strictEqual(strings[ep.textId], 'Steam');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    pkg.files.filter((f) => f !== 'javascript').forEach((f) => assert(fs.existsSync(path.join(PKG, f)), 'files[] names ' + f + ', which is missing'));
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
    const v2 = manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'];
    assert(v2 && v2.instances[0] === '1' && v2.attributes.statusCarSpeed2 === 'r', 'the manifest asks to read Vehicle2.statusCarSpeed2');
    assert(!/[^\x00-\x7f]/.test(JSON.stringify(UI)), 'uiDescription.json is ASCII');
    /* UUIDs of our own, not the browser's */
    const chromium = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'vizualyse_chromium', fs.readdirSync(path.join(ROOT, '..', 'vizualyse_chromium'))
        .find((n) => n.startsWith('vizualyse_chromium@') && !n.endsWith('.tgz')), 'rhmiData', 'application.json'), 'utf8')).application;
    [['uuid', APP_JSON.application.uuid, chromium.uuid], ['string bundle', APP_JSON.application.stringBundleUuid, chromium.stringBundleUuid],
        ['resource bundle', APP_JSON.application.resourceBundleUuid, chromium.resourceBundleUuid], ['entry point', ep.uuid, chromium.entryPoints[0].uuid]]
        .forEach((u) => assert.notStrictEqual(u[1], u[2], 'the ' + u[0] + ' UUID is the browser\'s'));
    console.log('ok   page: ' + BUTTONS.length + ' buttons, a QR graphic, an empty screen state, xml and uiDescription agree; tile, icon, files[]; Vehicle2 speed; ASCII; own UUIDs');

    process.exit = (code) => { throw new Error('process.exit(' + code + ')'); };
    runSource();
    const S = byName.steamStatus, G = byName.steamGame, D = byName.steamDownload;
    await until('no-tool status', () => /not running/.test(S.text || ''));
    assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
    ['steamShow', 'steamStop', 'steamResolution', 'steamEnable'].forEach((n) => assert.strictEqual(byName[n].enabled, false, n + ' disabled'));
    ['steamPlay1', 'steamPlay2', 'steamPlay3', 'steamPlay4'].forEach((n) => assert.strictEqual(byName[n].visible, false, n + ' hidden'));
    assert.strictEqual(byName.steamEnable.text, 'Steam: not running');
    assert.strictEqual(byName.steamQr.visible, false);
    console.log('ok   without the tool: "' + S.text + '", buttons off, no Play buttons, no QR');

    serve();
    await until('ready status', () => S.text === 'Ready - pick a game');
    assert.strictEqual(byName.steamLink.text, LINK1);
    assert(/^Scan with the phone/.test(byName.steamHint.text));
    await until('QR graphic', () => byName.steamQr.graphic);
    const qr1 = byName.steamQr.graphic.value;
    assert(handles.has(qr1) && fs.readFileSync(qr1).slice(1, 4).toString() === 'PNG', 'a PNG with a resource handle');
    assert.strictEqual(byName.steamPlay1.text, 'Play: Slay the Spire 2');
    assert.strictEqual(byName.steamPlay2.text, 'Play: Test Game');
    assert(byName.steamPlay1.visible && byName.steamPlay2.visible && !byName.steamPlay3.visible && !byName.steamPlay4.visible, 'a Play button per game');
    assert(byName.steamPlay1.enabled && byName.steamPlay2.enabled, 'Play on');
    assert.strictEqual(byName.steamShow.enabled, false, 'nothing to show');
    assert.strictEqual(byName.steamStop.enabled, false, 'nothing to stop');
    assert.strictEqual(byName.steamResolution.text, 'Picture: 1280x720');
    assert.strictEqual(D.visible, false, 'no download row');
    console.log('ok   connected: "' + S.text + '"; QR; "' + byName.steamPlay1.text + '", "' + byName.steamPlay2.text + '", two Play rows hidden');

    /* Play from the car: play sent; starting; once it draws the screen state opens and show goes */
    byName.steamPlay1.emit('action');
    await until('play sent', () => received.some((c) => c.cmd === 'play' && c.appId === STS2.appId));
    st = Object.assign({}, st, { running: true, game: GAME('starting') });
    tool.broadcast();
    await until('starting', () => S.text === 'Starting Slay the Spire 2 (this can take a minute)...' && byName.steamPlay1.text === 'Playing: Slay the Spire 2');
    assert(byName.steamStop.enabled && !byName.steamShow.enabled && !byName.steamPlay2.enabled, 'Stop on, Show and the other Play off while starting');
    assert.strictEqual(G.text, 'Slay the Spire 2: starting');
    st = Object.assign({}, st, { game: GAME('running') });
    tool.broadcast();
    await until('the screen state opened by itself', () => opened.length === 1 && opened[0] === byName[SCREEN]);
    await until('show sent once it is visible', () => sent('show'));
    await until('shown', () => /^On the screen/.test(S.text || ''));
    await until('every button off while covered', () => BUTTONS.every((n) => byName[n].enabled === false || byName[n].visible === false));
    assert.strictEqual(G.text, 'Slay the Spire 2: 28 pictures/s');
    console.log('ok   Play sends play; "starting"; once it draws the empty screen state opens and the game shows; buttons off while covered');

    /* BACK: hidden, still running; Show again opens the screen state; Stop */
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    await until('hide on BACK', () => count('hide') === 1, 1500);
    await until('running, hidden', () => S.text === 'Slay the Spire 2 is running - Show puts it on the screen' && byName.steamShow.enabled === true);
    await sleep(600);
    assert.strictEqual(count('show'), 1, 'hidden by BACK, not shown again by itself');
    await sleep(450);
    byName.steamShow.emit('action');
    await until('the screen state again', () => opened.length === 2);
    await until('shown again', () => st.shown);
    byName[SCREEN].emit('focus', { focus: false });
    await until('hide on a pop-up', () => count('hide') === 2, 2000);
    byName[SCREEN].emit('focus', { focus: true });
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    await until('Stop on', () => byName.steamStop.enabled === true);
    await sleep(450);
    byName.steamStop.emit('action');
    await until('stop sent', () => sent('stop'));
    st = Object.assign({}, st, { running: false, shown: false, game: GAME('ended', { note: 'stopped on the iDrive page' }) });
    tool.broadcast();
    await until('ended', () => G.text === 'Slay the Spire 2 ended: stopped on the iDrive page' && byName.steamPlay1.text === 'Play: Slay the Spire 2' && byName.steamPlay1.enabled);
    console.log('ok   BACK and a pop-up hide it (it keeps running); Show opens the screen state again; Stop sends stop');

    /* Play, but the game ends before it draws: no screen state */
    const before = opened.length;
    await sleep(450);
    byName.steamPlay2.emit('action');
    await until('play 4242', () => received.some((c) => c.cmd === 'play' && c.appId === OTHER.appId));
    st = Object.assign({}, st, { running: true, game: Object.assign(GAME('starting'), { appId: OTHER.appId, name: OTHER.name }) });
    tool.broadcast();
    await until('starting 2', () => /^Starting Test Game/.test(S.text || ''));
    st = Object.assign({}, st, { running: false, game: Object.assign(GAME('ended', { note: 'the game ended before it drew anything (exit 1)' }), { appId: OTHER.appId, name: OTHER.name }) });
    tool.broadcast();
    await until('ended 2', () => G.text === 'Test Game ended: the game ended before it drew anything (exit 1)');
    st = Object.assign({}, st, { game: Object.assign(GAME('running'), { appId: OTHER.appId, name: OTHER.name }), running: true });
    tool.broadcast();
    await sleep(600);
    assert.strictEqual(opened.length, before, 'a game not started from here (or after its end) is not shown by itself');
    st = Object.assign({}, st, { running: false, game: null });
    tool.broadcast();
    console.log('ok   a game that ends before drawing: its note, nothing shown');

    /* the download row, the questions on the phone */
    st = Object.assign({}, st, { download: { appId: 99, name: 'Big Game', state: 'code', kind: 'app', note: 'Steam Guard: the code from the Steam app', percent: 0 } });
    tool.broadcast();
    await until('download row', () => D.visible === true && D.text === 'Steam Guard asks for a code - answer on the phone page');
    st = Object.assign({}, st, { download: Object.assign({}, st.download, { state: 'downloading', percent: 42.4 }) });
    tool.broadcast();
    await until('progress', () => D.text === 'Downloading Big Game: 42 %');
    st = Object.assign({}, st, { download: Object.assign({}, st.download, { state: 'done', percent: 100 }), library: [STS2, OTHER,
        { appId: 99, name: 'Big Game', exe: 'Big.exe', args: '', engine: 'unity', sizeMb: 900 }, { appId: 98, name: 'Odd Game', exe: null, args: '', engine: null, sizeMb: 1 },
        { appId: 97, name: 'Fifth', exe: 'f.exe', args: '', engine: null, sizeMb: 1 }] });
    tool.broadcast();
    await until('four Play rows', () => byName.steamPlay3.visible && byName.steamPlay4.visible && byName.steamPlay3.text === 'Play: Big Game');
    assert.strictEqual(byName.steamPlay4.text, 'Play: Odd Game (no program found)');
    assert.strictEqual(byName.steamPlay4.enabled, false, 'no program: no Play');
    assert.strictEqual(D.text, 'Big Game is installed');
    assert.strictEqual(byName.steamPlay3.enabled, true);
    /* Big Game on a USB stick that was pulled */
    st = Object.assign({}, st, { library: st.library.map((g) => (g.appId === 99 ? Object.assign({}, g, { usb: 'D3EA-4CE7', present: false }) : g)) });
    tool.broadcast();
    await until('the stick away', () => byName.steamPlay3.text === 'Play: Big Game (USB stick not plugged in)');
    assert.strictEqual(byName.steamPlay3.enabled, false, 'stick away: no Play');
    st = Object.assign({}, st, { library: st.library.map((g) => (g.appId === 99 ? Object.assign({}, g, { present: true }) : g)) });
    tool.broadcast();
    await until('the stick back', () => byName.steamPlay3.text === 'Play: Big Game' && byName.steamPlay3.enabled);
    console.log('ok   the download row (a Steam Guard question, progress, done); four Play rows at most; a game without a program, or on a pulled USB stick, can\'t be played');

    /* Picture: the next resolution; "from the next game" while one runs */
    await sleep(450);
    byName.steamResolution.emit('action');
    await until('resolution sent', () => sent('resolution'));
    st = Object.assign({}, st, { settings: Object.assign({}, st.settings, { resolution: '1344x480' }) });
    tool.broadcast();
    await until('the new picture', () => byName.steamResolution.text === 'Picture: 1344x480');
    console.log('ok   Picture sends resolution and shows the size');

    /* out of memory, the restart note, moving, a command's error */
    st = Object.assign({}, st, { running: true, game: GAME('running'), memory: Object.assign({}, st.memory, { note: 'out of memory', oomAt: new Date().toISOString() }) });
    tool.broadcast();
    await until('out of memory', () => S.text === 'Out of memory - the game needed more than 2560 MB (phone page: Memory)');
    st = Object.assign({}, st, { memory: Object.assign({}, st.memory, { oomAt: new Date(Date.now() - 130000).toISOString() }) });
    tool.broadcast();
    await until('gone after 2 min', () => /is running/.test(S.text || ''));
    await sleep(1200);
    assert(!received.some((c) => c.cmd === 'speed'), 'no speed sent while the car gives none (65535)');
    speedRaw = 30 * 64;
    await until('speed 30 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 30), 3000);
    st = Object.assign({}, st, { moving: true, speed: 30 });
    tool.broadcast();
    await until('moving', () => S.text === 'Only while parked - the car is moving (30 km/h)' && byName.steamShow.enabled === false);
    st = Object.assign({}, st, { moving: false, speed: 0, running: false, game: null, restartNote: 'the unit restarted while Slay the Spire 2 ran (2026-11-06T20:00:00Z)' });
    speedRaw = 0;
    tool.broadcast();
    await until('the restart note', () => S.text === 'Note: the unit restarted while Slay the Spire 2 ran (2026-11-06T20:00:00Z)');
    refuse = 'another game is running: stop it first';
    await sleep(450);
    byName.steamPlay2.emit('action');
    await until('command error', () => S.text === 'Error: another game is running: stop it first');
    console.log('ok   out of memory for 2 minutes; the speed goes to the tool; "only while parked"; the restart note; a command\'s error');

    /* installing, off / on, the tool going away */
    st = Object.assign({}, st, { bundle: 'unpacking', restartNote: null });
    await sleep(450);
    byName.steamResolution.emit('action');          /* a good command clears the error */
    await until('installing', () => /^Installing Steam on the car/.test(S.text || '') && !byName.steamPlay1.visible);
    st = Object.assign({}, st, { bundle: 'ready' });
    tool.broadcast();
    await sleep(450);
    byName.steamEnable.emit('action');
    await until('disable sent', () => sent('disable'));
    st = Object.assign({}, st, { enabled: false, link: null });
    tool.broadcast();
    await until('off', () => /^Off/.test(S.text || '') && byName.steamEnable.text === 'Steam: off' && byName.steamQr.visible === false && !byName.steamPlay1.visible);
    await sleep(450);
    byName.steamEnable.emit('action');
    await until('enable sent', () => sent('enable'));
    st = Object.assign({}, st, { enabled: true, link: LINK2 });
    tool.broadcast();
    await until('new QR', () => byName.steamQr.graphic.value !== qr1 && byName.steamLink.text === LINK2);
    await until('old QR released', () => destroyed.indexOf(qr1) >= 0 && !fs.existsSync(qr1));
    console.log('ok   installing; off / on send disable and enable (off hides the QR and the games); a new link, a new QR, the old released');

    byName[STATE].emit('visible', { visible: false });
    const n = count('speed');
    await sleep(1500);
    assert.strictEqual(tool.clients(), 1, 'the socket stays open with the page hidden');
    assert(count('speed') > n, 'the speed goes on with the page hidden');
    byName[STATE].emit('visible', { visible: true });
    assert(!received.some((c) => !/^(speed|show|hide|play|stop|resolution|enable|disable)$/.test(c.cmd)), 'nothing else sent');
    tool.close();
    await until('tool gone', () => /not running/.test(S.text || ''));
    assert.strictEqual(byName.steamEnable.enabled, false);
    console.log('ok   hiding the page keeps the socket and the speed; the tool going away: "' + S.text + '"');

    assert(!logs.some((l) => /^(error|warn)/.test(l)), logs.filter((l) => /^(error|warn)/.test(l)).join('\n'));
    console.log('all page tests passed');
}

main().then(() => { try { fs.rmSync(QR_DIR, { recursive: true, force: true }); } catch (e) { /* left */ } process.exitCode = 0; setTimeout(() => require('process').reallyExit(0), 50); },
    (e) => { console.error('FAIL ' + e.message); console.error(logs.slice(-15).join('\n')); setTimeout(() => require('process').reallyExit(1), 50); });
