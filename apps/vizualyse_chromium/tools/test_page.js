// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against a
 * fake SDK and HMI built from the shipped uiDescription.json, talking to a
 * fake vizualyse-chromium control socket (the protocol in
 * src/chromium_control.js) with a scripted status.
 *
 *   node tools/test_page.js
 *
 * Covers: application.xml and uiDescription.json agree and the app binds
 * every button; with no tool the status says so and the buttons are off;
 * connected, the link is written and shown as a QR PNG (a new file per
 * link, the old handle released), the page and the GPU lines; Show, Home
 * page, Reload and Back send theirs; a pop-up (focus lost 300 ms) and
 * leaving the page send hide, a focus blip does not; the car's speed (a
 * fake Vehicle2) goes to the tool once a second, also with the page
 * hidden; "only while parked"; a failed command's error; installing,
 * starting, a software WebGPU; on / off; the tool going away.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\vchrome-test-' + process.pid : path.join(os.tmpdir(), 'vchrome-' + process.pid + '.sock');
const QR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vchrome-qr-'));
process.env.CHROMIUM_CTL_SOCKET = PIPE;
process.env.CHROMIUM_QR_DIR = QR_DIR;

const STAGED = fs.readdirSync(ROOT).find((n) => n.startsWith('vizualyse_chromium@') && !n.endsWith('.tgz'));
const PKG = path.join(ROOT, STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));
const STATE = 'ST_OnlineApps_VizualyseChromium';
const SCREEN = 'ST_OnlineApps_VizualyseChromiumScreen';

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
    getAppId() { return 'vizualyse_chromium'; }
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

/* ---- a fake vizualyse-chromium control socket --------------------------- */
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

const LINK1 = 'http://172.20.10.2:8491/?t=0123456789abcdef';
const LINK2 = 'http://172.20.10.3:8491/?t=0123456789abcdef';
const GPU = { mode: 'cpu', webgpu: 'google / swiftshader', webgpuFallback: true, webgpuCompute: 'ok', webgl2: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', jspi: 'ok', at: '2026-11-05T20:00:00Z' };
/* the GPU mode on the car: ANGLE on the unit's Mesa 19 GLES */
const GPU_GLES = Object.assign({}, GPU, { mode: 'gpu', webgl2: 'ANGLE (Intel Open Source Technology Center, Mesa DRI Intel(R) HD Graphics 505 (APL 3) , OpenGL ES 3.2 Mesa 19.0.6)' });
const BASE = { enabled: true, link: LINK1, uplink: 'online', bundle: 'ready', browser: 'running', shown: false, url: 'https://webglreport.com/?v=2',
    title: 'WebGL Report', home: 'https://webglreport.com/?v=2', gpu: GPU, gpuMode: false, gpuNote: null, speed: null, moving: false, pictures: 0, decodeMs: 0, view: '1790x638', error: null };
let st = Object.assign({}, BASE);
const received = [];
let refuse = null;
let tool = null;
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
    assert.strictEqual(comps['21'].name, 'browserQr');
    assert(/<component id="21" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR is a scalable graphic label');
    const buttons = Object.keys(comps).filter((id) => comps[id].type === 'button').map((id) => comps[id].name).sort();
    assert.deepStrictEqual(buttons, ['browserBack', 'browserEnable', 'browserGame', 'browserGpuMode', 'browserHome', 'browserReload', 'browserResolution', 'browserRoom', 'browserShow']);
    const ep = APP_JSON.application.entryPoints[0];
    assert(fs.existsSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'images', ep.icon)), 'the tile icon ships');
    const strings = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'variantGroups', 'Common', 'texts', 'en_GB.json'), 'utf8'));
    assert.strictEqual(strings[ep.textId], 'Browser');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
    pkg.files.filter((f) => f !== 'javascript').forEach((f) => assert(fs.existsSync(path.join(PKG, f)), 'files[] names ' + f + ', which is missing'));
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
    const v2 = manifest.proxies['de.bmw.infotainment.vehicle.Vehicle2'];
    assert(v2 && v2.instances[0] === '1' && v2.attributes.statusCarSpeed2 === 'r', 'the manifest asks to read Vehicle2.statusCarSpeed2');
    /* plain ASCII in every text the page starts with (Unicode is unreliable in RHMI Text) */
    assert(!/[^\x00-\x7f]/.test(JSON.stringify(UI)), 'uiDescription.json is ASCII');
    console.log('ok   page: 8 buttons, a QR graphic, an empty screen state, xml and uiDescription agree; tile text, icon and files[]; Vehicle2 speed in the manifest; ASCII');

    process.exit = (code) => { throw new Error('process.exit(' + code + ')'); };
    runSource();
    const S = byName.browserStatus, P = byName.browserPage, G = byName.browserGpu;
    await until('no-tool status', () => /not running/.test(S.text || ''));
    assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
    ['browserShow', 'browserEnable', 'browserGpuMode', 'browserResolution', 'browserRoom', 'browserGame', 'browserHome', 'browserReload', 'browserBack'].forEach((n) => assert.strictEqual(byName[n].enabled, false, n + ' disabled'));
    assert.strictEqual(byName.browserEnable.text, 'Browser: not running');
    assert.strictEqual(byName.browserQr.visible, false);
    console.log('ok   without the tool: "' + S.text + '", buttons disabled, no QR');

    serve();
    await until('ready status', () => /^Ready/.test(S.text || ''));
    assert.strictEqual(byName.browserLink.text, LINK1);
    assert(/^Scan with the phone/.test(byName.browserHint.text));
    await until('QR graphic', () => byName.browserQr.graphic);
    const qr1 = byName.browserQr.graphic.value;
    assert(handles.has(qr1) && fs.readFileSync(qr1).slice(1, 4).toString() === 'PNG', 'a PNG with a resource handle');
    assert.strictEqual(byName.browserEnable.text, 'Browser: on');
    ['browserShow', 'browserEnable', 'browserGpuMode', 'browserResolution', 'browserRoom', 'browserGame', 'browserHome', 'browserReload', 'browserBack'].forEach((n) => assert.strictEqual(byName[n].enabled, true, n + ' enabled'));
    assert.strictEqual(P.text, 'WebGL Report - https://webglreport.com/?v=2');
    assert.strictEqual(G.text, 'WebGPU: CPU (SwiftShader) | WebGL 2: CPU (SwiftShader) | JSPI: ok');
    assert(G.text.length <= 90, 'the GPU line is one row');
    console.log('ok   connected: "' + S.text + '"; page "' + P.text + '"; "' + G.text + '"');

    byName.browserHome.emit('action'); byName.browserReload.emit('action'); byName.browserBack.emit('action');
    await until('home, reload, back sent', () => sent('home') && sent('reload') && sent('back'));
    console.log('ok   Home page, Reload, Back send theirs');

    /* the GPU mode: on restarts the browser on the GPU, the row says what it got; off any time */
    assert.strictEqual(byName.browserGpuMode.text, 'GPU mode: off (WebGL on the CPU)');
    await sleep(450);
    byName.browserGpuMode.emit('action');
    await until('gpu on sent', () => received.some((c) => c.cmd === 'gpu' && c.on === true));
    st = Object.assign({}, st, { gpuMode: true, browser: 'starting', gpu: null });
    tool.broadcast();
    await until('starting on the GPU', () => /^Starting the browser on the GPU/.test(S.text || '') && byName.browserGpuMode.text === 'GPU mode: on (experimental)' &&
        byName.browserGpuMode.enabled === true && byName.browserShow.enabled === false);
    st = Object.assign({}, st, { browser: 'running', gpu: GPU });
    tool.broadcast();
    await until('not probed on the GPU yet', () => G.text === 'GPU: checking...');
    st = Object.assign({}, st, { gpu: GPU_GLES });
    tool.broadcast();
    await until('WebGL 2 on the GPU', () => G.text === 'WebGPU: CPU (SwiftShader) | WebGL 2: GLES 3.2, Intel HD Graphics 505 (APL 3) | JSPI: ok');
    assert(G.text.length <= 90, 'the GPU mode line is one row');
    await sleep(450);
    byName.browserGpuMode.emit('action');
    await until('gpu off sent', () => received.some((c) => c.cmd === 'gpu' && c.on === false));
    st = Object.assign({}, st, { gpuMode: false, gpu: GPU, gpuNote: 'the GPU did not start (WebGL 2: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0): back on the CPU; chrome://gpu has why' });
    tool.broadcast();
    await until('the note shown', () => /^GPU mode: the GPU did not start/.test(G.text || '') && byName.browserGpuMode.text === 'GPU mode: off (WebGL on the CPU)');
    st = Object.assign({}, st, { gpuNote: null });
    tool.broadcast();
    await until('the line back', () => G.text === 'WebGPU: CPU (SwiftShader) | WebGL 2: CPU (SwiftShader) | JSPI: ok');
    st = Object.assign({}, st, { gpuMode: true, gpu: Object.assign({}, GPU_GLES, { webgpu: 'ANGLE (Intel Open Source Technology Center, Mesa DRI Intel(R) HD Graphics 505 (Broxton) , OpenGL ES 3.2)', webgpuFallback: false, webgpuBackend: 'openGLES', webgpuCore: false,
        webgl2: 'ANGLE (Intel Open Source Technology Center, Mesa DRI Intel(R) HD Graphics 505 (Broxton) , OpenGL ES 3.2)' }) });
    tool.broadcast();
    await until('WebGPU compat on the GPU', () => G.text === 'WebGPU: GLES compat | WebGL 2: GLES 3.2, Intel HD Graphics 505 (Broxton) | JSPI: ok');
    st = Object.assign({}, st, { gpuMode: false, gpu: GPU });
    tool.broadcast();
    await until('the CPU line again', () => G.text === 'WebGPU: CPU (SwiftShader) | WebGL 2: CPU (SwiftShader) | JSPI: ok');
    console.log('ok   GPU mode: on / off send gpu; starting on the GPU, WebGL 2 on GLES, WebGPU in compatibility mode, the note of a failed try');

    /* the resolution: full -> 3/4 -> 1/2 -> full */
    const RES = [{ scale: 1, w: 1790, h: 638 }, { scale: 0.75, w: 1340, h: 476 }, { scale: 0.5, w: 892, h: 316 }];
    st = Object.assign({}, st, { scale: 1, resolutions: RES });
    tool.broadcast();
    await until('resolution full', () => byName.browserResolution.text === 'Resolution: full (1790x638)');
    await sleep(450);
    byName.browserResolution.emit('action');
    await until('scale 0.75 sent', () => received.some((c) => c.cmd === 'scale' && c.scale === 0.75));
    st = Object.assign({}, st, { scale: 0.75 });
    tool.broadcast();
    await until('resolution 3/4', () => byName.browserResolution.text === 'Resolution: 3/4 (1340x476)');
    st = Object.assign({}, st, { scale: 0.5 });
    tool.broadcast();
    await until('resolution 1/2', () => byName.browserResolution.text === 'Resolution: 1/2 (892x316)');
    await sleep(450);
    byName.browserResolution.emit('action');
    await until('back to full sent', () => received.some((c) => c.cmd === 'scale' && c.scale === 1));
    st = Object.assign({}, st, { scale: 1 });
    tool.broadcast();
    console.log('ok   Resolution steps full, 3/4, 1/2 and round again (scale), its size on the button');

    /* make room: on / off, what the tool paused on the button */
    assert.strictEqual(byName.browserRoom.text, 'Make room: off');
    await sleep(450);
    byName.browserRoom.emit('action');
    await until('room on sent', () => received.some((c) => c.cmd === 'room' && c.on === true));
    st = Object.assign({}, st, { room: { on: true, units: ['vizualyse-moonlight', 'vizualyse-cast'], paused: ['vizualyse-moonlight', 'vizualyse-cast'], note: null } });
    tool.broadcast();
    await until('paused shown', () => byName.browserRoom.text === 'Make room: on (Moonlight, Cast paused)');
    await sleep(450);
    byName.browserRoom.emit('action');
    await until('room off sent', () => received.some((c) => c.cmd === 'room' && c.on === false));
    st = Object.assign({}, st, { room: { on: false, units: [], paused: [], note: null } });
    tool.broadcast();
    await until('room off shown', () => byName.browserRoom.text === 'Make room: off');
    console.log('ok   Make room sends room on / off and shows what is paused');

    /* game mode: on / off */
    assert.strictEqual(byName.browserGame.text, 'Game mode: off');
    await sleep(450);
    byName.browserGame.emit('action');
    await until('game on sent', () => received.some((c) => c.cmd === 'game' && c.on === true));
    st = Object.assign({}, st, { gameMode: true });
    tool.broadcast();
    await until('game on shown', () => byName.browserGame.text === 'Game mode: on (trusted games only)');
    await sleep(450);
    byName.browserGame.emit('action');
    await until('game off sent', () => received.some((c) => c.cmd === 'game' && c.on === false));
    st = Object.assign({}, st, { gameMode: false });
    tool.broadcast();
    await until('game off shown', () => byName.browserGame.text === 'Game mode: off');
    console.log('ok   Game mode sends game on / off and shows it');

    /* a page too big for the memory cap: said on the status line for 2 minutes */
    st = Object.assign({}, st, { memory: { capMb: 1536, choices: [1536, 2048, 2560], usedMb: 900, peakMb: 1536, oomAt: new Date().toISOString(), note: 'out of memory: ...' } });
    tool.broadcast();
    await until('out of memory said', () => S.text === 'Out of memory - the page needed more than 1536 MB (phone page: Memory)');
    st = Object.assign({}, st, { memory: Object.assign({}, st.memory, { oomAt: new Date(Date.now() - 130000).toISOString() }) });
    tool.broadcast();
    await until('and gone after 2 minutes', () => /^Ready/.test(S.text || ''));
    console.log('ok   running out of memory shows on the status line for 2 minutes');

    /* Show: the empty screen state first, the browser once it is visible */
    await sleep(450);
    byName.browserShow.emit('action');
    await until('the screen state opened', () => opened.length === 1 && opened[0] === byName[SCREEN]);
    await until('show sent once it is visible', () => sent('show'));
    await until('shown', () => /^On the screen/.test(S.text || ''));
    await until('every button off while covered', () => ['browserShow', 'browserEnable', 'browserGpuMode', 'browserResolution', 'browserRoom', 'browserGame', 'browserHome', 'browserReload', 'browserBack'].every((n) => byName[n].enabled === false));
    await sleep(600);
    assert.strictEqual(count('hide'), 0, 'the main state going away for the screen state does not hide');
    console.log('ok   Show opens the empty screen state, then sends show; the main page\'s buttons are off while covered');

    /* a pop-up takes the screen state's focus: hidden after a moment */
    byName[SCREEN].emit('focus', { focus: false });
    await until('hide sent on focus loss', () => sent('hide'), 2000);
    await until('buttons back', () => byName.browserShow.enabled === true && byName.browserHome.enabled === true);
    byName[SCREEN].emit('focus', { focus: true });
    /* shown again on the open screen state at once; a focus blip: nothing */
    await sleep(450);
    byName.browserShow.emit('action');
    await until('shown again', () => st.shown);
    assert.strictEqual(opened.length, 1, 'the screen state, still open, is not opened again');
    const hides = count('hide');
    byName[SCREEN].emit('focus', { focus: false });
    await sleep(100);
    byName[SCREEN].emit('focus', { focus: true });
    await sleep(600);
    assert.strictEqual(count('hide'), hides, 'a short focus blip does not hide');
    /* BACK: the screen state goes, the main page comes back: hidden */
    byName[SCREEN].emit('visible', { visible: false });
    byName[STATE].emit('visible', { visible: true });
    await until('hide sent on BACK', () => count('hide') === hides + 1, 1500);
    console.log('ok   a pop-up (focus lost 300 ms) and BACK hide the browser; a focus blip does not');

    /* the HMI won't open the screen state: the browser goes over the main page, its buttons off */
    openFails = true;
    await sleep(450);
    byName.browserShow.emit('action');
    await until('fallback show', () => st.shown, 2000);
    await until('buttons off over the main page', () => byName.browserHome.enabled === false);
    assert(logs.some((l) => /^warn: screen state: openState failed/.test(l)), 'the fallback is logged');
    logs.splice(0, logs.length, ...logs.filter((l) => !/^warn: screen state:/.test(l)));
    openFails = false;
    byName[STATE].emit('focus', { focus: false });
    await until('hidden by the pop-up', () => !st.shown, 2000);
    byName[STATE].emit('focus', { focus: true });
    console.log('ok   without the screen state the browser goes over the main page with its buttons off');

    await sleep(1200);
    assert(!received.some((c) => c.cmd === 'speed'), 'no speed sent while the car gives none (65535)');
    speedRaw = 0;
    await until('speed 0 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 0), 3000);
    speedRaw = 30 * 64;
    await until('speed 30 sent', () => received.some((c) => c.cmd === 'speed' && c.kmh === 30), 3000);
    st = Object.assign({}, st, { moving: true, speed: 30, shown: false });
    tool.broadcast();
    await until('moving shown', () => /^Only while parked - the car is moving \(30 km\/h\)/.test(S.text || '') && byName.browserShow.enabled === false);
    st = Object.assign({}, st, { moving: false, speed: 0 });
    speedRaw = 0;
    tool.broadcast();
    await until('ready again', () => /^Ready/.test(S.text || '') && byName.browserShow.enabled === true);
    console.log('ok   the speed goes to the tool once a second (none while invalid); "only while parked" shows, Show off');

    refuse = 'the browser is not running';
    await sleep(450);
    byName.browserReload.emit('action');
    await until('command error shown', () => S.text === 'Error: the browser is not running');
    console.log('ok   a failed command shows its error');

    /* a button's error stays 10 s: past it, the tool's own states show */
    await sleep(450);
    byName.browserHome.emit('action');
    await until('the error cleared by a good command', () => !/^Error/.test(S.text || ''));
    st = Object.assign({}, st, { bundle: 'unpacking', browser: 'off', gpu: null, title: '' });
    tool.broadcast();
    await until('installing', () => /^Installing the browser/.test(S.text || ''));
    assert.strictEqual(byName.browserShow.enabled, false);
    st = Object.assign({}, st, { bundle: 'ready', browser: 'starting' });
    tool.broadcast();
    await until('starting', () => /^Starting the browser/.test(S.text || '') && G.text === '');
    st = Object.assign({}, st, { browser: 'running', title: 'WebGL Report', gpu: Object.assign({}, GPU, { webgpu: 'google / swiftshader', webgpuFallback: true }) });
    tool.broadcast();
    await until('software WebGPU said', () => /^WebGPU: CPU \(SwiftShader\)/.test(G.text || ''));
    console.log('ok   installing / starting shown; a software WebGPU fallback is called so: "' + G.text + '"');

    await sleep(450);
    byName.browserEnable.emit('action');
    await until('disable sent', () => sent('disable'));
    st = Object.assign({}, st, { enabled: false, link: null, browser: 'off' });
    tool.broadcast();
    await until('off status', () => /^Off/.test(S.text || ''));
    assert.strictEqual(byName.browserEnable.text, 'Browser: off');
    assert.strictEqual(byName.browserQr.visible, false, 'no QR while off');
    assert.strictEqual(byName.browserShow.enabled, false);
    await sleep(450);
    byName.browserEnable.emit('action');
    await until('enable sent', () => sent('enable'));
    st = Object.assign({}, st, { enabled: true, link: LINK1, browser: 'running' });
    tool.broadcast();
    await until('back on', () => /^Ready/.test(S.text || '') && byName.browserQr.visible === true);
    console.log('ok   on / off sends disable and enable; off hides the QR and Show');

    const qrBefore = byName.browserQr.graphic.value;
    st = Object.assign({}, st, { link: LINK2 });
    tool.broadcast();
    await until('new QR', () => byName.browserQr.graphic.value !== qrBefore && byName.browserLink.text === LINK2);
    await until('old QR released', () => destroyed.indexOf(qrBefore) >= 0 && !fs.existsSync(qrBefore));
    assert(destroyed.indexOf(qr1) >= 0 && !fs.existsSync(qr1), 'the first QR was released when it was replaced');
    console.log('ok   a new link: new QR file, the old handle released and its file removed');

    st = Object.assign({}, st, { link: null, uplink: 'offline' });
    tool.broadcast();
    await until('no hotspot', () => /waiting for the hotspot, uplink offline/.test(S.text || '') && byName.browserQr.visible === false);
    st = Object.assign({}, st, { link: LINK2, uplink: 'online' });
    tool.broadcast();
    await until('link back', () => byName.browserQr.visible === true);
    console.log('ok   no link: waiting for the hotspot, the QR hidden');

    byName[STATE].emit('visible', { visible: false });
    const n = count('speed');
    await sleep(1500);
    assert.strictEqual(tool.clients(), 1, 'the socket stays open with the page hidden');
    assert(count('speed') > n, 'the speed goes on with the page hidden');
    byName[STATE].emit('visible', { visible: true });
    assert(!received.some((c) => !/^(speed|show|hide|home|reload|back|enable|disable|gpu|scale|room|game)$/.test(c.cmd)), 'nothing else sent');
    console.log('ok   hiding the page keeps the socket and the speed going');

    tool.close();
    await until('tool gone', () => /not running/.test(S.text || ''));
    assert.strictEqual(byName.browserEnable.enabled, false);
    console.log('ok   the tool going away: "' + S.text + '"');

    assert(!logs.some((l) => /^(error|warn)/.test(l)), logs.filter((l) => /^(error|warn)/.test(l)).join('\n'));
    console.log('all page tests passed');
}

main().then(() => { try { fs.rmSync(QR_DIR, { recursive: true, force: true }); } catch (e) { /* left */ } process.exitCode = 0; setTimeout(() => require('process').reallyExit(0), 50); },
    (e) => { console.error('FAIL ' + e.message); console.error(logs.slice(-15).join('\n')); setTimeout(() => require('process').reallyExit(1), 50); });
