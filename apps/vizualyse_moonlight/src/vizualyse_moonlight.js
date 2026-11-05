// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_moonlight - the iDrive page of the vizualyse-moonlight tool,
 * which streams games from a PC running Sunshine to this screen. Pairing,
 * the host and the game are picked on the phone page the tool serves.
 *
 * One LT_State_Wide page: the status; the phone page's link as a QR code
 * (LT_Label_1Graphic_Scalable, a PNG in /dev/shm the HMI can read) and as
 * text; Moonlight on or off; Stop (the game keeps running on the PC); Quit
 * game (closes it on the PC); Resume last (the last host and game again);
 * and an info line (host, game, fps, controllers). The app holds the tool's
 * control socket while its page is visible (moonlight_control.js); the tool
 * keeps running without it. The structure follows vizualyse_cast.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { MoonlightControl } = require('./moonlight_control.js');
const { qrPng } = require('./qr_png.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseMoonlight';
const N = {
    status: 'moonlightStatus', qr: 'moonlightQr', link: 'moonlightLink', hint: 'moonlightHint', info: 'moonlightInfo',
    enable: 'moonlightEnable', stop: 'moonlightStop', quit: 'moonlightQuit', resume: 'moonlightResume',
};
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;
const QR_PX = 360;
const QR_PREFIX = 'qr_';

/* The QR folder: world-readable, so the HMI (another uid) can load the PNG. */
function qrDir() {
    if (process.env.MOONLIGHT_QR_DIR) return process.env.MOONLIGHT_QR_DIR;
    const uid = process.getuid ? process.getuid() : 0;
    return '/dev/shm/vizualyse_moonlight_qr_' + uid;
}

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 1) + '…' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class MoonlightApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._qr = { key: null, file: null, chain: Promise.resolve() };
        this._control = new MoonlightControl({ log: logger });
        this._control.on('change', () => this._render());

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_moonlight init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_moonlight ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                if (foregroundStart) this.registerActive();
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.indexOf(reason) >= 0;
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        if (!this._state) return Promise.reject(new Error('uiDescription has no ' + STATE_NAME));
        const names = Object.keys(N).map((k) => N[k]);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) return Promise.reject(new Error('uiDescription lacks ' + missing.join(', ')));

        this._bind(N.enable, () => (this._control.enabled() ? this._control.disable() : this._control.enable()));
        this._bind(N.stop, () => this._control.stop());
        this._bind(N.quit, () => this._control.quit());
        this._bind(N.resume, () => this._control.resume());
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) this._press(entry.name, entry.handler);
        });
        rhmi.on('applicationStackChanged', (stack) => {
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) return;
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._qr.key = null;
            this._render();
        });
        this._state.on('visible', (event) => {
            const visible = isTrue(event && event.visible);
            if (visible) this._sawForeground = true;
            this._setVisible(visible);
        });
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info('page ready: ' + names.length + ' components found');
            this._render();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try { id = comp.getId(); } catch (e) { id = null; }
        if (id !== null) this._actionById[Number(id)] = { name: name, handler: handler };
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) return;
        this._lastPress[name] = now;
        logger.info('BUTTON ACTION ' + name);
        try {
            if (handler() === false) logger.warn(name + ': the Moonlight service is not connected');
        } catch (err) {
            logger.warn(name + ' failed: ' + (err && err.message));
        }
    }

    /* The app manager inserts the tile from application.json and hands it to
     * the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) return Promise.reject(new Error('no entry point handed over by the manager'));
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn('entry point text/icon: ' + (err && err.message))))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info('entry point ' + description.name + ' ENABLED'));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) return Promise.resolve();
        this._sawForeground = true;
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn('openEntryState failed: ' + (err && err.message)));
    }

    /* ---- visibility ---- */
    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) return;
        this._visible = visible;
        logger.info('page ' + (visible ? 'visible' : 'hidden'));
        this._reportVisibilityStatus(visible);
        if (visible) this._control.open();
        else this._control.close();
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) return;
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()]
            : [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn('app status report failed: ' + (err && err.message))));
    }

    /* ---- rendering ---- */
    _write(name, text) {
        const t = oneRow(text);
        if (this._written[name] !== t) {
            this._written[name] = t;
            Promise.resolve(this._components[name].setValue(0, 'Text', t, 'Text'))
                .catch((err) => logger.warn(name + ' render failed: ' + (err && err.message)));
        }
    }

    _setEnabled(name, enabled) {
        const key = 'enabled:' + name;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            Promise.resolve(this._components[name].setEnabled(enabled))
                .catch((err) => logger.warn(name + ' enable failed: ' + (err && err.message)));
        }
    }

    _show(name, visible) {
        const key = 'visible:' + name;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            Promise.resolve(this._components[name].setVisible(visible))
                .catch((err) => logger.warn(name + ' visibility failed: ' + (err && err.message)));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) return;
        const c = this._control, up = c.connected(), on = up && c.enabled(), link = on ? c.link() : '';
        this._write(N.status, c.statusText());
        this._write(N.link, link ? link : '');
        this._write(N.hint, link ? 'Scan with the phone whose hotspot the car is on to pair and pick the PC and game' : '');
        this._write(N.info, c.infoText());
        this._write(N.enable, 'Moonlight: ' + (up ? (c.enabled() ? 'on' : 'off') : 'not running'));
        this._setEnabled(N.enable, up);
        this._setEnabled(N.stop, on && c.active());
        this._setEnabled(N.quit, on && c.active());
        this._setEnabled(N.resume, on && !c.active() && c.canResume());
        this._showQr(link);
    }

    /* The link as a QR code: a new PNG file for each new link (the HMI does
     * not load a path again), the old one released once the new one shows. */
    _showQr(text) {
        const q = this._qr, comp = this._components[N.qr], rhmi = this.rhmiApplication;
        this._show(N.qr, !!text);
        if (q.key === (text || '') || !comp || !rhmi) return;
        q.key = text || '';
        q.chain = q.chain.then(() => {
            const bundle = rhmi.getResourceBundle();
            const old = q.file;
            if (!text) {
                q.file = null;
                return old ? this._retireQr(bundle, old) : undefined;
            }
            const dir = qrDir();
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
            fs.chmodSync(dir, 0o755);
            const r = qrPng(text, QR_PX);
            const file = path.join(dir, QR_PREFIX + Date.now() + '.png');
            fs.writeFileSync(file, r.png);
            fs.chmodSync(file, 0o644);
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => comp.setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    q.file = file;
                    logger.info('QR code ' + r.width + 'x' + r.width + ' px (' + r.modules + ' modules)');
                    return old ? this._retireQr(bundle, old) : undefined;
                }, (err) => this._retireQr(bundle, file).then(() => { throw err; }));
        }).catch((err) => {
            q.key = null;
            logger.warn('QR code failed: ' + (err && err.message));
        });
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn('QR handle ' + path.basename(file) + ': ' + (err && err.message)))
            .then(() => { try { fs.unlinkSync(file); } catch (e) { /* gone already */ } });
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        logger.info('vizualyse_moonlight shutdown: ' + JSON.stringify(reason));
        this._control.close();
        const bundle = this.rhmiApplication && this.rhmiApplication.getResourceBundle();
        this._shutdownPromise = Promise.resolve()
            .then(() => (this._qr.file && bundle ? this._retireQr(bundle, this._qr.file) : undefined))
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new MoonlightApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_moonlight failed to start: ' + (err && err.message));
});
