// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against a
 * fake SDK and HMI built from the shipped uiDescription.json, talking to the
 * tool's real control socket module (native/vizualyse-cast/src/control.js)
 * with a scripted status.
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree and the app binds
 * every button; with no tool the status says so; connected and idle, the
 * link is written and shown as a QR PNG (a new file per link, the old handle
 * released); Stop and Play last follow the tool's state and send stop and
 * replay; the console button hides without mgu-render; the QR toggle sends
 * the opposite of the tool's state; hiding the page closes the socket and
 * showing it again reconnects; the tool going away is shown.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\vcast-test-' + process.pid : path.join(os.tmpdir(), 'vcast-' + process.pid + '.sock');
const QR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vcast-qr-'));
process.env.CAST_CTL_SOCKET = PIPE;
process.env.CAST_QR_DIR = QR_DIR;

const STAGED = fs.readdirSync(ROOT).find((n) => n.startsWith('vizualyse_cast@') && !n.endsWith('.tgz'));
const PKG = path.join(ROOT, STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));
const { startControl } = require(path.join(ROOT, '..', '..', 'native', 'vizualyse-cast', 'src', 'control.js'));

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
        this.text = null; this.graphic = null; this.enabled = null;
        this.visible = desc && desc.properties && desc.properties.Visible ? desc.properties.Visible.value === 1 : null;
    }
    getId() { return this.id; }
    setValue(row, cell, value, type) { if (cell === 'Graphic') this.graphic = { value, type }; else this.text = value; return Promise.resolve(); }
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
    getAppId() { return 'vizualyse_cast'; }
    getEntryPoints() { return this._eps; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}
function runSource() {
    const Module = require('module');
    const load = Module._load;
    const FAKES = { 'oap-sdk/src/core/OnlineApp.js': OnlineApp, 'oap-sdk/src/logging/logging': { getSDKLogger: () => logger } };
    Module._load = function (req, parent, isMain) { return FAKES[req] || load.call(this, req, parent, isMain); };
    require(path.join(ROOT, MANIFEST.modules[0]));
}

/* ---- the tool's side, scripted ------------------------------------------ */
const LINK1 = 'http://172.20.10.2:8480/?t=0123456789abcdef';
const LINK2 = 'http://172.20.10.3:8480/?t=0123456789abcdef';
const OUTPUTS = [{ id: 'map' }, { id: 'hud' }, { id: 'console' }, { id: 'none' }];
let st = { state: 'idle', uplink: 'online', render: 'connected', qr: true, link: LINK1, canReplay: false, outputs: OUTPUTS };
const received = [];
let control = null;
function serve() {
    control = startControl({ status: () => st, command: (c) => { received.push(c); return null; }, log: () => {} });
}

async function main() {
    const comps = UI.containers['1'].components;
    const xmlIds = (XML.match(/<component id="(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]).sort();
    assert.deepStrictEqual(Object.keys(comps).sort(), xmlIds, 'application.xml and uiDescription.json list the same components');
    assert.strictEqual(comps['21'].name, 'castQr');
    assert(/<component id="21" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR is a scalable graphic label');
    const buttons = Object.keys(comps).filter((id) => comps[id].type === 'button').map((id) => comps[id].name).sort();
    assert.deepStrictEqual(buttons, ['castCarplayHud', 'castCarplayMap', 'castConsole', 'castEnable', 'castHud', 'castMap', 'castQrToggle', 'castStop']);
    console.log('ok   page: 8 buttons, a QR graphic, xml and uiDescription agree');

    process.exit = (code) => { throw new Error('process.exit(' + code + ')'); };
    runSource();
    const S = byName.castStatus;
    await until('no-tool status', () => /not running/.test(S.text || ''));
    assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
    assert.strictEqual(byName.castStop.enabled, false);
    console.log('ok   without the tool: "' + S.text + '", buttons disabled');

    serve();
    await until('ready status', () => /^Ready/.test(S.text || ''));
    assert.strictEqual(byName.castLink.text, LINK1);
    await until('QR graphic', () => byName.castQr.graphic);
    const qr1 = byName.castQr.graphic.value;
    assert.strictEqual(byName.castQr.graphic.type, 'ResourceId');
    assert(handles.has(qr1) && fs.readFileSync(qr1).slice(1, 4).toString() === 'PNG', 'a PNG with a resource handle');
    assert.strictEqual(byName.castQr.visible, true);
    assert.strictEqual(byName.castMap.enabled, false, 'nothing to replay yet');
    assert.strictEqual(byName.castStop.enabled, false);
    console.log('ok   connected: "' + S.text + '", link written, QR ' + path.basename(qr1));

    st = Object.assign({}, st, { state: 'playing', output: 'map', audio: true, seconds: 12, canReplay: true, url: 'https://example.org/v.mkv?…' });
    control.broadcast();
    await until('playing', () => /^Playing on the cluster map, with sound/.test(S.text || ''));
    assert.strictEqual(byName.castStop.enabled, true);
    assert.strictEqual(byName.castConsole.enabled, true);
    byName.castConsole.emit('action');
    await until('replay sent', () => received.some((c) => c.cmd === 'replay' && c.output === 'console'));
    await sleep(450);
    byName.castStop.emit('action');
    await until('stop sent', () => received.some((c) => c.cmd === 'stop'));
    byName.castQrToggle.emit('action');
    await until('qr sent', () => received.some((c) => c.cmd === 'qr' && c.show === false));
    console.log('ok   playing: "' + S.text + '"; Play last on this screen, Stop and the QR toggle send replay, stop, qr off');

    assert.strictEqual(byName.castCarplayMap.enabled, false, 'no CarPlay second screen without hook111');
    st = Object.assign({}, st, { carplay: { armed: true, ready: true, mode: 'alt' } });
    control.broadcast();
    await until('carplay enabled', () => byName.castCarplayMap.enabled === true && byName.castCarplayHud.enabled === true);
    await sleep(450);
    byName.castCarplayMap.emit('action');
    await until('carplay map sent', () => received.some((c) => c.cmd === 'carplay' && c.output === 'map'));
    byName.castCarplayHud.emit('action');
    await until('carplay hud sent', () => received.some((c) => c.cmd === 'carplay' && c.output === 'hud'));
    assert.strictEqual(byName.castEnable.text, 'Cast to cluster: on');
    byName.castEnable.emit('action');
    await until('disable sent', () => received.some((c) => c.cmd === 'disable'));
    st = Object.assign({}, st, { enabled: false, state: 'idle' });
    control.broadcast();
    await until('off status', () => /^Off/.test(S.text || ''));
    assert.strictEqual(byName.castEnable.text, 'Cast to cluster: off');
    assert.strictEqual(byName.castQr.visible, false, 'no QR while off');
    assert.strictEqual(byName.castCarplayMap.enabled, false);
    assert.strictEqual(byName.castMap.enabled, false);
    await sleep(450);
    byName.castEnable.emit('action');
    await until('enable sent', () => received.some((c) => c.cmd === 'enable'));
    st = Object.assign({}, st, { enabled: true, state: 'playing' });
    control.broadcast();
    await until('back on', () => /^Playing/.test(S.text || '') && byName.castQr.visible === true);
    console.log('ok   CarPlay map on the cluster / the HUD send carplay map / hud (only with hook111 ready); on/off sends disable and enable, off hides the QR and disables the rest');

    st = Object.assign({}, st, { qr: false, outputs: OUTPUTS.filter((o) => o.id !== 'console') });
    control.broadcast();
    await until('console hidden', () => byName.castConsole.visible === false);
    assert(/: off$/.test(byName.castQrToggle.text));
    console.log('ok   without mgu-render the console button hides; toggle reads "' + byName.castQrToggle.text + '"');

    const qrBefore = byName.castQr.graphic.value;
    st = Object.assign({}, st, { link: LINK2 });
    control.broadcast();
    await until('new QR', () => byName.castQr.graphic.value !== qrBefore && byName.castLink.text === LINK2);
    await until('old QR released', () => destroyed.indexOf(qrBefore) >= 0 && !fs.existsSync(qrBefore));
    assert(destroyed.indexOf(qr1) >= 0 && !fs.existsSync(qr1), 'the first QR was released when it was replaced');
    assert.strictEqual(byName.castLink.text, LINK2);
    console.log('ok   a new link: new QR file, the old handle released and its file removed');

    byName.ST_OnlineApps_VizualyseCast.emit('visible', { visible: false });
    await until('closed on hide', () => /not running/.test(S.text || ''));
    const n = received.length;
    byName.ST_OnlineApps_VizualyseCast.emit('visible', { visible: true });
    await until('reconnected on show', () => /^Playing/.test(S.text || ''));
    assert.strictEqual(received.length, n, 'showing the page sends nothing');
    console.log('ok   hiding the page closes the socket, showing it reconnects');

    control.close();
    await until('tool gone', () => /not running/.test(S.text || ''));
    console.log('ok   the tool going away: "' + S.text + '"');

    assert(!logs.some((l) => /^(error|warn)/.test(l)), logs.filter((l) => /^(error|warn)/.test(l)).join('\n'));
    console.log('all page tests passed');
}

main().then(() => { try { fs.rmSync(QR_DIR, { recursive: true, force: true }); } catch (e) { /* left */ } process.exitCode = 0; setTimeout(() => require('process').reallyExit(0), 50); },
    (e) => { console.error('FAIL ' + e.message); console.error(logs.slice(-15).join('\n')); setTimeout(() => require('process').reallyExit(1), 50); });
