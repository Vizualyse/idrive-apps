// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against a
 * fake SDK and HMI built from the shipped uiDescription.json, talking to a
 * fake vizualyse-moonlight control socket (the protocol in
 * src/moonlight_control.js) with a scripted status.
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree and the app binds
 * every button; with no tool the status says so and the buttons are off;
 * connected and idle, the link is written and shown as a QR PNG (a new file
 * per link, the old handle released); Resume last follows canResume and
 * sends resume; Stop and Quit game follow the stream and send stop and quit;
 * the info line shows host, game, fps and controllers; a failed command's
 * error shows; on / off sends disable and enable, off hides the QR; the
 * output drop-down shows the tool's choice and sends a new one; the car's
 * speed (a fake Vehicle2) goes to the tool once a second, and keeps going
 * with the page hidden (the socket stays open); "only while parked" shows;
 * the tool going away is shown.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\vmoon-test-' + process.pid : path.join(os.tmpdir(), 'vmoon-' + process.pid + '.sock');
const QR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmoon-qr-'));
process.env.MOONLIGHT_CTL_SOCKET = PIPE;
process.env.MOONLIGHT_QR_DIR = QR_DIR;

const STAGED = fs.readdirSync(ROOT).find((n) => n.startsWith('vizualyse_moonlight@') && !n.endsWith('.tgz'));
const PKG = path.join(ROOT, STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));
const STATE = 'ST_OnlineApps_VizualyseMoonlight';

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
    getAppId() { return 'vizualyse_moonlight'; }
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

/* ---- a fake vizualyse-moonlight control socket --------------------------- */
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

const LINK1 = 'http://172.20.10.2:8490/?t=0123456789abcdef';
const LINK2 = 'http://172.20.10.3:8490/?t=0123456789abcdef';
const BASE = { enabled: true, link: LINK1, uplink: 'online', render: 'connected', state: 'idle', host: null, app: null,
    frames: 0, fps: 0, seconds: 0, pads: [], canResume: false, last: null, error: null, note: null };
let st = Object.assign({}, BASE);
const received = [];
let refuse = null;
let tool = null;
function serve() {
    tool = startFakeTool({ status: () => st, command: (c) => { received.push(c); if (c.cmd === 'speed') return null; const r = refuse; refuse = null; return r; } });
}
const sent = (cmd) => received.some((c) => c.cmd === cmd);

async function main() {
    const comps = UI.containers['1'].components;
    assert.strictEqual(UI.containers['1'].name, STATE);
    const xmlIds = (XML.match(/<component id="(\d+)"/g) || []).map((m) => m.match(/\d+/)[0]).sort();
    assert.deepStrictEqual(Object.keys(comps).sort(), xmlIds, 'application.xml and uiDescription.json list the same components');
    assert.strictEqual(comps['21'].name, 'moonlightQr');
    assert(/<component id="21" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR is a scalable graphic label');
    const buttons = Object.keys(comps).filter((id) => comps[id].type === 'button').map((id) => comps[id].name).sort();
    assert.deepStrictEqual(buttons, ['moonlightEnable', 'moonlightQuit', 'moonlightResume', 'moonlightStop']);
    const ep = APP_JSON.application.entryPoints[0];
    assert(fs.existsSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'images', ep.icon)), 'the tile icon ships');
    const strings = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
    assert.strictEqual(strings[ep.textId], 'Moonlight');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    pkg.files.filter((f) => f !== 'javascript').forEach((f) => assert(fs.existsSync(path.join(PKG, f)), 'files[] names ' + f + ', which is missing'));
    const dd = Object.keys(comps).map((id) => comps[id]).filter((c) => c.type === 'dropDownMenu');
    assert(dd.length === 1 && dd[0].name === 'moonlightOutput' && dd[0].rows.map((r) => r.ItemText.value).join() === 'Centre console,Cluster,HUD' &&
        dd[0].cells.HeaderText.value === 'Picture on', 'the output drop-down');
    assert(/type="dropDownMenu" widget="LT_DropDownMenu_1Row_2Col3070"/.test(XML), 'the drop-down widget upstream proved on cars');
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
    const v2 = manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'];
    assert(v2 && v2.instances[0] === '1' && v2.attributes.statusCarSpeed2 === 'r', 'the manifest asks to read Vehicle2.statusCarSpeed2');
    console.log('ok   page: 4 buttons, the output drop-down, a QR graphic, xml and uiDescription agree; tile text, icon and files[]; Vehicle2 speed in the manifest');

    process.exit = (code) => { throw new Error('process.exit(' + code + ')'); };
    runSource();
    const S = byName.moonlightStatus, I = byName.moonlightInfo;
    await until('no-tool status', () => /not running/.test(S.text || ''));
    assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
    ['moonlightEnable', 'moonlightStop', 'moonlightQuit', 'moonlightResume'].forEach((n) => assert.strictEqual(byName[n].enabled, false, n + ' disabled'));
    assert.strictEqual(byName.moonlightEnable.text, 'Moonlight: not running');
    assert.strictEqual(byName.moonlightQr.visible, false);
    console.log('ok   without the tool: "' + S.text + '", buttons disabled, no QR');

    serve();
    await until('ready status', () => /^Ready/.test(S.text || ''));
    assert.strictEqual(byName.moonlightLink.text, LINK1);
    assert(/^Scan with the phone/.test(byName.moonlightHint.text));
    await until('QR graphic', () => byName.moonlightQr.graphic);
    const qr1 = byName.moonlightQr.graphic.value;
    assert.strictEqual(byName.moonlightQr.graphic.type, 'ResourceId');
    assert(handles.has(qr1) && fs.readFileSync(qr1).slice(1, 4).toString() === 'PNG', 'a PNG with a resource handle');
    assert.strictEqual(byName.moonlightQr.visible, true);
    assert.strictEqual(byName.moonlightEnable.text, 'Moonlight: on');
    assert.strictEqual(byName.moonlightEnable.enabled, true);
    assert.strictEqual(byName.moonlightResume.enabled, false, 'nothing to resume yet');
    assert.strictEqual(byName.moonlightStop.enabled, false);
    assert.strictEqual(byName.moonlightQuit.enabled, false);
    assert(/no controllers/.test(I.text) && /Uplink online/.test(I.text), I.text);
    await until('output shown', () => byName.moonlightOutput.cells.SelectedItem === 0 && byName.moonlightOutput.enabled === true);
    console.log('ok   connected: "' + S.text + '", link and hint written, QR ' + path.basename(qr1) + '; info "' + I.text + '"');

    st = Object.assign({}, st, { output: 'hud' });
    tool.broadcast();
    await until('the HUD chosen', () => byName.moonlightOutput.cells.SelectedItem === 2);
    byName.moonlightOutput.emit('action', { row: 1 });
    await until('output sent', () => received.some((c) => c.cmd === 'output' && c.output === 'map'));
    st = Object.assign({}, st, { output: 'map' });
    tool.broadcast();
    await until('the cluster chosen', () => byName.moonlightOutput.cells.SelectedItem === 1);
    console.log('ok   the output drop-down shows the tool\'s choice and sends a new one (row 1: map)');

    await sleep(1200);
    assert(!received.some((c) => c.cmd === 'speed'), 'no speed sent while the car gives none (65535)');
    speedRaw = 0;
    await until('speed 0 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 0), 3000);
    speedRaw = 30 * 64;
    await until('speed 30 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 30), 3000);
    st = Object.assign({}, st, { moving: true, speed: 30 });
    tool.broadcast();
    await until('moving shown', () => /^Only while parked — the car is moving \(30 km\/h\)/.test(S.text || ''));
    st = Object.assign({}, st, { moving: false, speed: 0 });
    speedRaw = 0;
    tool.broadcast();
    await until('ready again', () => /^Ready/.test(S.text || ''));
    console.log('ok   the speed goes to the tool once a second (none while invalid); "only while parked" shows');

    st = Object.assign({}, st, { canResume: true, last: { host: 'GAMING-PC', app: 'Forza Horizon 5' } });
    tool.broadcast();
    await until('resume enabled', () => byName.moonlightResume.enabled === true);
    assert(/last: Forza Horizon 5 on GAMING-PC/.test(I.text), I.text);
    byName.moonlightResume.emit('action');
    await until('resume sent', () => sent('resume'));
    st = Object.assign({}, st, { state: 'starting', host: { name: 'GAMING-PC', address: '172.20.10.5' }, app: { id: 881448767, name: 'Forza Horizon 5' } });
    tool.broadcast();
    await until('starting', () => /^Starting Forza Horizon 5 from GAMING-PC/.test(S.text || ''));
    assert.strictEqual(byName.moonlightResume.enabled, false, 'no resume while one starts');
    assert.strictEqual(byName.moonlightStop.enabled, true);
    console.log('ok   Resume last: enabled with canResume, sends resume; "' + S.text + '"');

    st = Object.assign({}, st, { state: 'streaming', frames: 1200, fps: 59, seconds: 20, pads: [{ name: 'Xbox Wireless Controller' }, { name: 'DualSense' }],
        decoder: 'msdk (GPU, API 1.24, GPU copy, Intel iHD driver)' });
    tool.broadcast();
    await until('streaming', () => /^Streaming Forza Horizon 5 from GAMING-PC — 20 s/.test(S.text || ''));
    await until('info', () => /^GAMING-PC \(172\.20\.10\.5\) · Forza Horizon 5 · 59 fps \(GPU\) · 2 controllers: Xbox/.test(I.text || ''));
    assert(I.text.length <= 90, 'the info line is one row');
    assert.strictEqual(byName.moonlightStop.enabled, true);
    assert.strictEqual(byName.moonlightQuit.enabled, true);
    byName.moonlightStop.emit('action');
    await until('stop sent', () => sent('stop'));
    byName.moonlightQuit.emit('action');
    await until('quit sent', () => sent('quit'));
    console.log('ok   streaming: "' + S.text + '"; info "' + I.text + '"; Stop and Quit game send stop and quit');

    st = Object.assign({}, st, { state: 'ended', fps: 0, note: 'the game keeps running on the PC' });
    tool.broadcast();
    await until('ended', () => /^Ended: Forza Horizon 5 from GAMING-PC — the game keeps running on the PC/.test(S.text || ''));
    assert.strictEqual(byName.moonlightStop.enabled, false);
    assert.strictEqual(byName.moonlightQuit.enabled, false);
    assert.strictEqual(byName.moonlightResume.enabled, true);
    console.log('ok   ended: "' + S.text + '"; Stop and Quit game off, Resume last on');

    refuse = 'the PC is not answering';
    await sleep(450);
    byName.moonlightResume.emit('action');
    await until('command error shown', () => S.text === 'Error: the PC is not answering');
    st = Object.assign({}, st, { state: 'error', error: 'connection to the host lost' });
    await sleep(450);
    byName.moonlightResume.emit('action');
    await until('stream error shown', () => S.text === 'Error: connection to the host lost');
    console.log('ok   a failed command shows its error; the stream\'s error shows: "' + S.text + '"');

    st = Object.assign({}, st, { state: 'idle', error: null, note: null, host: null, app: null, pads: [] });
    tool.broadcast();
    byName.moonlightEnable.emit('action');
    await until('disable sent', () => sent('disable'));
    st = Object.assign({}, st, { enabled: false, link: null });
    tool.broadcast();
    await until('off status', () => /^Off/.test(S.text || ''));
    assert.strictEqual(byName.moonlightEnable.text, 'Moonlight: off');
    assert.strictEqual(byName.moonlightQr.visible, false, 'no QR while off');
    assert.strictEqual(byName.moonlightLink.text, '');
    assert.strictEqual(byName.moonlightHint.text, '');
    assert.strictEqual(byName.moonlightResume.enabled, false);
    await sleep(450);
    byName.moonlightEnable.emit('action');
    await until('enable sent', () => sent('enable'));
    st = Object.assign({}, st, { enabled: true, link: LINK1 });
    tool.broadcast();
    await until('back on', () => /^Ready/.test(S.text || '') && byName.moonlightQr.visible === true);
    console.log('ok   on / off sends disable and enable; off hides the QR, the link and the hint');

    const qrBefore = byName.moonlightQr.graphic.value;
    st = Object.assign({}, st, { link: LINK2 });
    tool.broadcast();
    await until('new QR', () => byName.moonlightQr.graphic.value !== qrBefore && byName.moonlightLink.text === LINK2);
    await until('old QR released', () => destroyed.indexOf(qrBefore) >= 0 && !fs.existsSync(qrBefore));
    assert(destroyed.indexOf(qr1) >= 0 && !fs.existsSync(qr1), 'the first QR was released when it was replaced');
    console.log('ok   a new link: new QR file, the old handle released and its file removed');

    st = Object.assign({}, st, { link: null, uplink: 'offline' });
    tool.broadcast();
    await until('waiting for hotspot', () => /^Waiting for the phone’s hotspot \(uplink offline\)/.test(S.text || '') && byName.moonlightQr.visible === false);
    st = Object.assign({}, st, { link: LINK2, uplink: 'online' });
    tool.broadcast();
    await until('link back', () => byName.moonlightQr.visible === true);
    console.log('ok   no link: "Waiting for the phone’s hotspot", the QR hidden');

    byName[STATE].emit('visible', { visible: false });
    const n = received.filter((c) => c.cmd === 'speed').length;
    await sleep(1500);
    assert.strictEqual(tool.clients(), 1, 'the socket stays open with the page hidden');
    assert(received.filter((c) => c.cmd === 'speed').length > n, 'the speed goes on with the page hidden');
    byName[STATE].emit('visible', { visible: true });
    assert(!received.some((c) => !/^(speed|output|resume|stop|quit|enable|disable)$/.test(c.cmd)), 'nothing else sent');
    console.log('ok   hiding the page keeps the socket and the speed going');

    tool.close();
    await until('tool gone', () => /not running/.test(S.text || ''));
    assert.strictEqual(byName.moonlightEnable.enabled, false);
    console.log('ok   the tool going away: "' + S.text + '"');

    assert(!logs.some((l) => /^(error|warn)/.test(l)), logs.filter((l) => /^(error|warn)/.test(l)).join('\n'));
    console.log('all page tests passed');
}

main().then(() => { try { fs.rmSync(QR_DIR, { recursive: true, force: true }); } catch (e) { /* left */ } process.exitCode = 0; setTimeout(() => require('process').reallyExit(0), 50); },
    (e) => { console.error('FAIL ' + e.message); console.error(logs.slice(-15).join('\n')); setTimeout(() => require('process').reallyExit(1), 50); });
