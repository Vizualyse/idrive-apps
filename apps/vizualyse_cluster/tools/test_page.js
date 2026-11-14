// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against a
 * fake SDK and HMI built from the shipped uiDescription.json, talking to a
 * fake vizualyse-cluster control socket (the protocol in
 * src/cluster_control.js) with a scripted status. (The scaffolding is
 * vizualyse_steam's.)
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree, the app binds every
 * button, its UUIDs are its own; with no tool the status says so and the
 * buttons are off; connected, a row per family (titles ASCII, the one in
 * use marked); a row sends use; Choose opens the empty screen state and
 * the picker goes up once it is visible, every button off meanwhile; BACK
 * and a pop-up hide it; moving: Choose off and "only while parked" from the
 * tool; Sport or Comfort cycles; the strip; on / off; a failed command's
 * error; the speed; the tool going away.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* the copies of the pinned platform version (release.json "platform") */
require(path.join(ROOT, '..', '..', 'platform', 'platform.js')).sync(ROOT);
const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\vcluster-test-' + process.pid : path.join(os.tmpdir(), 'vcluster-' + process.pid + '.sock');
process.env.CLUSTER_CTL_SOCKET = PIPE;

const STAGED = fs.readdirSync(ROOT).find((n) => n.startsWith('vizualyse_cluster@') && !n.endsWith('.tgz'));
const PKG = path.join(ROOT, STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8').replace(/\r\n/g, '\n');   /* a Windows checkout's CRLF */
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));
const STATE = 'ST_OnlineApps_VizualyseCluster';
const SCREEN = 'ST_OnlineApps_VizualyseClusterScreen';

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
        this.text = null; this.enabled = null;
        this.visible = desc && desc.properties && desc.properties.Visible ? desc.properties.Visible.value === 1 : null;
    }
    getId() { return this.id; }
    setValue(row, cell, value) { this.text = value; return Promise.resolve(); }
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
const rhmi = new EventEmitter();
rhmi.getByName = (n) => byName[n] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();
/* openState: the main state goes, the state opened comes (as the HMI does) */
const opened = [];
rhmi.openState = (st) => {
    opened.push(st);
    setImmediate(() => { byName[STATE].emit('visible', { visible: false }); st.emit('visible', { visible: true }); });
    return Promise.resolve();
};
rhmi.getResourceBundle = () => ({});
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
    getAppId() { return 'vizualyse_cluster'; }
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

/* ---- a fake vizualyse-cluster control socket ------------------------- */
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

/* the tool's themes, as its status lists them (titles with a middle dot) */
const FAMS = [['g20i1', 'G20 inspired 1'], ['g20i2', 'G20 inspired 2'], ['lci1', 'LCI inspired 1'], ['lci2', 'LCI inspired 2'],
    ['perf1', 'Performance 1'], ['perf2', 'Performance 2'], ['tri1', 'Three-dial 1'], ['tri2', 'Three-dial 2']];
const THEMES = [];
FAMS.slice().reverse().forEach((f) => {
    THEMES.push({ id: f[0] + 'c', title: f[1] + ' · Comfort', family: f[0], mode: 'comfort' });
    THEMES.push({ id: f[0], title: f[1], family: f[0], mode: 'sport' });
});
const BASE = { enabled: false, theme: 'g20i1', mode: 'auto', cover: false, showing: null, source: 'car', demo: false, bench: false, panel: null,
    moving: null, speed: null, themes: THEMES, signals: [], error: null, look: 'comfort', picker: false, trying: null, canTry: false };
let st = Object.assign({}, BASE);
const received = [];
let refuse = null;
let tool = null;
function serve() {
    tool = startFakeTool({ status: () => st, command: (c) => {
        received.push(c);
        if (c.cmd === 'speed') return null;
        const r = refuse; refuse = null;
        if (r) return r;
        if (c.cmd === 'picker') st = Object.assign({}, st, { picker: !!c.on });
        if (c.cmd === 'use') st = Object.assign({}, st, { enabled: true, theme: c.id, showing: c.id + 'c' });
        if (c.cmd === 'mode') st = Object.assign({}, st, { mode: c.mode });
        if (c.cmd === 'cover') st = Object.assign({}, st, { cover: c.on });
        if (c.cmd === 'enable') st = Object.assign({}, st, { enabled: true, showing: st.theme + 'c' });
        if (c.cmd === 'disable') st = Object.assign({}, st, { enabled: false, showing: null });
        return null;
    } });
}
const sent = (cmd) => received.some((c) => c.cmd === cmd);
const count = (cmd, f) => received.filter((c) => c.cmd === cmd && (!f || f(c))).length;
const THEME_ROWS = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => 'clusterTheme' + i);
const BUTTONS = ['clusterPick'].concat(THEME_ROWS, ['clusterMode', 'clusterCover', 'clusterEnable']);
const press = async (name) => { await sleep(450); byName[name].emit('action'); };

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
    const buttons = Object.keys(comps).filter((id) => comps[id].type === 'button').map((id) => comps[id].name).sort();
    assert.deepStrictEqual(buttons, BUTTONS.slice().sort());
    const ep = APP_JSON.application.entryPoints[0];
    assert(fs.existsSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'images', ep.icon)), 'the tile icon ships');
    const strings = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
    assert.strictEqual(strings[ep.textId], 'Cluster themes');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    pkg.files.filter((f) => f !== 'javascript').forEach((f) => assert(fs.existsSync(path.join(PKG, f)), 'files[] names ' + f + ', which is missing'));
    assert.strictEqual(pkg.oapAppSettings.loggingId, 'VCLU');
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
    const v2 = manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'];
    assert(v2 && v2.instances[0] === '1' && v2.attributes.statusCarSpeed2 === 'r', 'the manifest asks to read Vehicle2.statusCarSpeed2');
    assert(!/[^\x00-\x7f]/.test(JSON.stringify(UI)), 'uiDescription.json is ASCII');
    /* UUIDs of our own, not Steam's (the app it was copied from) or another's */
    ['vizualyse_steam', 'vizualyse_chromium', 'vizualyse_moonlight', 'vizualyse_cast'].forEach((other) => {
        const dir = path.join(ROOT, '..', other);
        if (!fs.existsSync(dir)) return;
        const o = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((n) => n.startsWith(other + '@') && !n.endsWith('.tgz')), 'rhmiData', 'application.json'), 'utf8')).application;
        [['uuid', APP_JSON.application.uuid, o.uuid], ['string bundle', APP_JSON.application.stringBundleUuid, o.stringBundleUuid],
            ['resource bundle', APP_JSON.application.resourceBundleUuid, o.resourceBundleUuid], ['entry point', ep.uuid, o.entryPoints[0].uuid]]
            .forEach((u) => assert.notStrictEqual(u[1], u[2], 'the ' + u[0] + ' UUID is ' + other + '\'s'));
    });
    console.log('ok   page: ' + BUTTONS.length + ' buttons, an empty screen state, xml and uiDescription agree; tile, icon, files[]; Vehicle2 speed; ASCII; own UUIDs');

    process.exit = (code) => { throw new Error('process.exit(' + code + ')'); };
    runSource();
    const S = byName.clusterStatus;
    await until('no-tool status', () => /not running/.test(S.text || ''));
    assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
    ['clusterPick', 'clusterMode', 'clusterCover', 'clusterEnable'].forEach((n) => assert.strictEqual(byName[n].enabled, false, n + ' disabled'));
    THEME_ROWS.forEach((n) => assert.strictEqual(byName[n].visible, false, n + ' hidden'));
    assert.strictEqual(byName.clusterEnable.text, 'Cluster themes: not running');
    console.log('ok   without the tool: "' + S.text + '", buttons off, no theme rows');

    serve();
    await until('off status', () => S.text === "Off - the car's own cluster shows");
    assert.deepStrictEqual(THEME_ROWS.map((n) => byName[n].text), FAMS.map((f) => f[1]), 'a row per family, in order, no mode in the title');
    assert(THEME_ROWS.every((n) => byName[n].visible && byName[n].enabled), 'the rows shown and on');
    assert(byName.clusterPick.enabled, 'Choose on (speed unknown: the tool decides)');
    assert.strictEqual(byName.clusterMode.text, 'Sport or Comfort: by the drive mode');
    assert.strictEqual(byName.clusterEnable.text, "Cluster themes: off (the car's own cluster)");
    console.log('ok   connected: "' + S.text + '"; 8 rows ("' + byName.clusterTheme1.text + '" ...)');

    /* a row: use (on with that family) */
    await press('clusterTheme4');
    await until('use lci2', () => received.some((c) => c.cmd === 'use' && c.id === 'lci2'));
    await until('in use', () => byName.clusterTheme4.text === 'In use: LCI inspired 2' && S.text === 'On the cluster: LCI inspired 2 (Comfort)');
    assert.strictEqual(byName.clusterEnable.text, 'Cluster themes: on');
    console.log('ok   a theme row sends use: "' + S.text + '", "' + byName.clusterTheme4.text + '"');

    /* Choose: the screen state, then the picker; every button off while it covers the page */
    await press('clusterPick');
    await until('the screen state opened', () => opened.length === 1 && opened[0] === byName[SCREEN]);
    await until('picker on sent once it is visible', () => count('picker', (c) => c.on === true) === 1);
    await until('the picker shown', () => /^The picker is on the screen/.test(S.text || ''));
    await until('every button off while covered', () => BUTTONS.every((n) => byName[n].enabled === false));
    console.log('ok   Choose opens the empty screen state, then the picker; buttons off while covered');

    /* what the picker changed shows on the page */
    st = Object.assign({}, st, { theme: 'tri1', showing: 'tri1' });
    tool.broadcast();
    await until('tri1 in use', () => byName.clusterTheme7.text === 'In use: Three-dial 1' && byName.clusterTheme4.text === 'LCI inspired 2');

    /* BACK hides it; Choose again; a pop-up hides it */
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    await until('picker off on BACK', () => count('picker', (c) => c.on === false) === 1, 1500);
    await until('the page back', () => S.text === 'On the cluster: Three-dial 1 (Sport)' && byName.clusterPick.enabled);
    await sleep(600);
    assert.strictEqual(count('picker', (c) => c.on === true), 1, 'hidden by BACK, not shown again by itself');
    await press('clusterPick');
    await until('the screen state again', () => opened.length === 2);
    await until('shown again', () => st.picker);
    byName[SCREEN].emit('focus', { focus: false });
    await until('picker off on a pop-up', () => count('picker', (c) => c.on === false) === 2, 2000);
    byName[SCREEN].emit('focus', { focus: true });
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    await until('the page back again', () => byName.clusterPick.enabled === true);
    console.log('ok   BACK and a pop-up hide the picker; Choose shows it again');

    /* the speed; moving: Choose off; the tool refusing the picker */
    await sleep(1200);
    assert(!sent('speed'), 'no speed sent while the car gives none (65535)');
    speedRaw = 30 * 64;
    await until('speed 30 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 30), 3000);
    st = Object.assign({}, st, { moving: true, speed: 30 });
    tool.broadcast();
    await until('moving', () => byName.clusterPick.enabled === false && byName.clusterPick.text === 'Choose with previews (only while parked)');
    assert(byName.clusterTheme1.enabled, 'the theme rows still work while driving');
    st = Object.assign({}, st, { moving: false, speed: 0 });
    speedRaw = 0;
    tool.broadcast();
    await until('parked', () => byName.clusterPick.enabled);
    refuse = 'only while parked';
    await press('clusterPick');
    await until('the refusal', () => S.text === 'Error: only while parked');
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    console.log('ok   the speed goes to the tool; moving: Choose off, the rows still on; the tool\'s refusal shown');

    /* Sport or Comfort cycles; the strip; off and on */
    await press('clusterMode');
    await until('mode sport', () => received.some((c) => c.cmd === 'mode' && c.mode === 'sport') && byName.clusterMode.text === 'Sport or Comfort: always Sport');
    await press('clusterMode');
    await until('mode comfort', () => byName.clusterMode.text === 'Sport or Comfort: always Comfort');
    await press('clusterMode');
    await until('mode auto', () => byName.clusterMode.text === 'Sport or Comfort: by the drive mode');
    await press('clusterCover');
    await until('covered', () => received.some((c) => c.cmd === 'cover' && c.on === true) && byName.clusterCover.text === "The car's strip under the theme: covered (black)");
    await press('clusterEnable');
    await until('off', () => sent('disable') && S.text === "Off - the car's own cluster shows" && !/In use/.test(byName.clusterTheme7.text));
    await press('clusterEnable');
    await until('on', () => sent('enable') && /^On the cluster: Three-dial 1/.test(S.text));
    console.log('ok   Sport or Comfort cycles auto, sport, comfort; the strip covered; off and on');

    /* the page hidden: the socket and the speed go on; the tool going away */
    byName[STATE].emit('visible', { visible: false });
    const n = count('speed');
    await sleep(1500);
    assert.strictEqual(tool.clients(), 1, 'the socket stays open with the page hidden');
    assert(count('speed') > n, 'the speed goes on with the page hidden');
    byName[STATE].emit('visible', { visible: true });
    assert(!received.some((c) => !/^(speed|picker|use|mode|cover|enable|disable)$/.test(c.cmd)), 'nothing else sent');
    tool.close();
    await until('tool gone', () => /not running/.test(S.text || ''));
    assert.strictEqual(byName.clusterEnable.enabled, false);
    assert(THEME_ROWS.every((r) => byName[r].visible === false), 'no rows without the tool');
    console.log('ok   hiding the page keeps the socket and the speed; the tool going away: "' + S.text + '"');

    assert(!logs.some((l) => /^(error|warn)/.test(l)), logs.filter((l) => /^(error|warn)/.test(l)).join('\n'));
    console.log('all page tests passed');
}

main().then(() => { process.exitCode = 0; setTimeout(() => require('process').reallyExit(0), 50); },
    (e) => { console.error('FAIL ' + e.message); console.error(logs.slice(-15).join('\n')); setTimeout(() => require('process').reallyExit(1), 50); });
