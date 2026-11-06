// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_steam - the iDrive page of the vizualyse-steam tool: Windows games
 * from the owner's Steam library running on the car through Proton, shown on
 * this screen while parked. Signing in to Steam and installing games happen
 * on the phone page the tool serves (typing).
 *
 * One LT_State_Wide page: the status; what plays; Show on the screen; Stop
 * the game; a Play button for each installed game (up to four); the
 * download; the phone page's link as a QR code (LT_Label_1Graphic_Scalable,
 * a PNG in /dev/shm the HMI can read) and as text; Picture (the size the
 * game draws at); Steam on or off.
 *
 * The game covers the app area (not the HMI's top bar or left strip). The
 * HMI still gets every touch on it, so Show first opens the screen state
 * (ST_..._VizualyseSteamScreen: a title and a label, nothing to press) and
 * the game goes up once that state is visible; while it is up, every button
 * of the main page is disabled too (should the screen state not open). The
 * game shows only while the state under it is visible and focused: BACK (the
 * arrow outside the game), HOME, another app, or an HMI pop-up taking the
 * focus (a call, a warning) hides it, so nothing of the HMI is ever covered.
 * Hidden, the game keeps running; Stop ends it. Play from this page shows
 * the game by itself once it draws, if the page is still in front.
 *
 * Only while parked: the app reads the car's speed once a second
 * (vehicle_speed.js) and hands it to the tool, which hides the game above
 * 3 km/h and won't show it. So the app holds the tool's control socket while
 * it runs, not only while its page shows. The structure follows
 * vizualyse_chromium.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { SteamControl, ascii } = require('./steam_control.js');
const { watchSpeed } = require('./vehicle_speed.js');
const { qrPng } = require('./qr_png.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseSteam';
const SCREEN_NAME = 'ST_OnlineApps_VizualyseSteamScreen';
/* how long the screen state may take to show after openState */
const SCREEN_OPEN_MS = 3000;
const N = {
    status: 'steamStatus', game: 'steamGame', show: 'steamShow', stop: 'steamStop',
    play1: 'steamPlay1', play2: 'steamPlay2', play3: 'steamPlay3', play4: 'steamPlay4',
    download: 'steamDownload', qr: 'steamQr', link: 'steamLink', hint: 'steamHint',
    resolution: 'steamResolution', enable: 'steamEnable',
};
const PLAY = [N.play1, N.play2, N.play3, N.play4];
/* an HMI pop-up takes the focus while the page stays visible; leaving or
 * switching states takes it too, just before 'visible' goes: wait this long
 * to tell them apart */
const FOCUS_LOST_MS = 300;
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;
const QR_PX = 360;
const QR_PREFIX = 'qr_';

/* The QR folder: world-readable, so the HMI (another uid) can load the PNG. */
function qrDir() {
    if (process.env.STEAM_QR_DIR) return process.env.STEAM_QR_DIR;
    const uid = process.getuid ? process.getuid() : 0;
    return '/dev/shm/vizualyse_steam_qr_' + uid;
}

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 3) + '...' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class SteamApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._screen = null;
        /* per state: visible, focused (assumed with visible until told otherwise) */
        this._st = { main: { visible: false, focused: false }, screen: { visible: false, focused: false } };
        this._wantScreen = false;
        this._shownOn = 'screen';
        this._autoShow = null;           /* the app id Play was pressed for here: shown once it draws */
        this._playIds = [null, null, null, null];
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._qr = { key: null, file: null, chain: Promise.resolve() };
        this._control = new SteamControl({ log: logger });
        this._control.on('change', () => { this._render(); this._maybeAutoShow(); });
        this._stopSpeed = null;

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_steam init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_steam ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        /* the tool hears from the app while it runs: the speed, whatever the page */
        this._control.open();
        this._startSpeed();
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

    _startSpeed() {
        let builders = null;
        try { builders = require('oap-sdk/src/someip/someipBuilders'); } catch (err) {
            logger.warn('speed: no SOME/IP in this SDK (' + (err && err.message) + '): the tool cannot tell parked from driving');
            return;
        }
        this._stopSpeed = watchSpeed(builders, logger, (kmh) => this._control.speed(kmh));
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

        this._screen = rhmi.getByName(SCREEN_NAME);
        if (!this._screen) logger.warn('uiDescription has no ' + SCREEN_NAME + ': Show puts the game over the main page');
        this._bind(N.show, () => this._showGame());
        this._bind(N.stop, () => { this._autoShow = null; return this._control.stop(); });
        PLAY.forEach((name, i) => this._bind(name, () => this._play(this._playIds[i])));
        this._bind(N.resolution, () => this._control.resolution());
        this._bind(N.enable, () => (this._control.enabled() ? this._control.disable() : this._control.enable()));
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
        this._watchState(this._state, 'main');
        if (this._screen) this._watchState(this._screen, 'screen');
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info('page ready: ' + names.length + ' components found');
            this._render();
        });
    }

    /* Play from this page: the game shows by itself once it draws */
    _play(appId) {
        if (!appId) return true;
        this._autoShow = appId;
        return this._control.play(appId);
    }

    /* the game Play was pressed for draws, our page is in front, parked: up */
    _maybeAutoShow() {
        if (!this._autoShow) return;
        const c = this._control;
        if (c.gameId() !== this._autoShow) {
            /* it ended, or never started (the tool said why) */
            if (c.connected() && !c.running() && c.gameState() === 'ended') this._autoShow = null;
            return;
        }
        if (c.gameState() !== 'running' || c.shown() || c.moving()) return;
        /* our main page in front: its state says so, or (no state event yet
         * since a foreground start) the app is */
        const m = this._st.main;
        const front = this._stateEvents ? m.visible && m.focused : this._visible && !this._st.screen.visible;
        if (!front) return;
        this._autoShow = null;
        logger.info('the game draws: showing it');
        this._showGame();
    }

    /* visible / focus of one of the two states */
    _watchState(state, key) {
        state.on('visible', (event) => {
            const visible = isTrue(event && event.visible);
            this._stateEvents = true;
            this._st[key].visible = visible;
            this._st[key].focused = visible;
            if (visible) this._sawForeground = true;
            logger.info(key + ' state ' + (visible ? 'visible' : 'hidden'));
            if (key === 'screen' && visible && this._wantScreen) {
                this._wantScreen = false;
                clearTimeout(this._screenTimer);
                this._showOn('screen');
            }
            this._recheck();
        });
        state.on('focus', (event) => {
            this._st[key].focused = isTrue(event && event.focus);
            this._recheck();
        });
    }

    /* After a short wait (the HMI moves visibility and focus one event at a
     * time): the app is visible while either state is, and the game stays
     * up only while the state it was shown on is visible and focused (BACK
     * from the screen state brings the main page back: that hides it too). */
    _recheck() {
        clearTimeout(this._focusTimer);
        this._focusTimer = setTimeout(() => {
            const m = this._st.main, sc = this._st.screen;
            this._setVisible(m.visible || sc.visible);
            const on = this._st[this._shownOn];
            if (!(on.visible && on.focused) && !this._wantScreen && this._control.hide()) logger.info('our page left or covered (a pop-up?): game hidden');
            this._maybeAutoShow();
        }, FOCUS_LOST_MS);
    }

    /* Show: the screen state first, the game once it is visible; without it
     * (no such state, or the HMI won't open it) the game goes over the main
     * page, whose buttons are disabled meanwhile (_render). */
    _showGame() {
        const rhmi = this.rhmiApplication, screen = this._screen;
        if (!screen) return this._showOn('main');
        if (this._st.screen.visible) return this._showOn('screen');
        if (!this._control.running()) return this._control.show();   /* the tool says why */
        this._wantScreen = true;
        const fallback = (why) => {
            if (!this._wantScreen) return;
            this._wantScreen = false;
            logger.warn('screen state: ' + why + '; the game goes over the main page');
            this._showOn('main');
        };
        clearTimeout(this._screenTimer);
        this._screenTimer = setTimeout(() => fallback('not visible ' + SCREEN_OPEN_MS + ' ms after openState'), SCREEN_OPEN_MS);
        if (typeof rhmi.openState !== 'function') { fallback('this SDK has no openState'); return true; }
        const open = (arg) => Promise.resolve().then(() => rhmi.openState(arg));
        open(screen).catch((err) => {
            logger.info('openState(state) failed (' + (err && err.message) + '), trying its id');
            return open(screen.getId());
        }).catch((err) => fallback('openState failed: ' + (err && err.message)));
        return true;
    }

    /* the game up over one of our states ('main' or 'screen') */
    _showOn(key) {
        this._shownOn = key;
        return this._control.show();
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
            if (handler() === false) logger.warn(name + ': the Steam tool is not connected');
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
        logger.info('app ' + (visible ? 'visible' : 'hidden'));
        /* off our pages the game must not cover whatever the HMI shows */
        if (!visible && this._control.hide()) logger.info('app left: game hidden');
        this._reportVisibilityStatus(visible);
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
            const comp = this._components[name];
            Promise.resolve(comp.setEnabled ? comp.setEnabled(enabled) : comp.setProperty('Enabled', enabled ? 1 : 0, 'UInt'))
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
        const c = this._control, up = c.connected(), on = up && c.enabled(), ready = on && c.ready();
        const run = on && c.running(), link = on ? c.link() : '';
        /* while the game covers the page, nothing under it can be pressed */
        const covered = c.shown();
        this._write(N.status, c.statusText());
        this._write(N.game, on ? c.gameText() : '');
        this._write(N.download, on ? c.downloadText() : '');
        this._write(N.link, link ? link : '');
        this._write(N.hint, link ? 'Scan with the phone whose hotspot the car is on: sign in to Steam, install games' : '');
        this._write(N.enable, 'Steam: ' + (up ? (c.enabled() ? 'on' : 'off') : 'not running'));
        this._write(N.resolution, up ? c.resolutionText() : 'Picture');
        this._setEnabled(N.show, run && c.gameState() === 'running' && !covered && !c.moving());
        this._setEnabled(N.stop, run && !covered);
        this._setEnabled(N.enable, up && !covered);
        this._setEnabled(N.resolution, on && !covered);
        const games = ready ? c.library().slice(0, PLAY.length) : [];
        const playing = c.gameId();
        PLAY.forEach((name, i) => {
            const g = games[i];
            this._playIds[i] = g ? g.appId : null;
            this._show(name, !!g);
            if (!g) return;
            this._write(name, (playing === g.appId ? 'Playing: ' : 'Play: ') + ascii(g.name) + (g.exe ? '' : ' (no program found)'));
            this._setEnabled(name, !run && !covered && !c.moving() && !!g.exe);
        });
        this._show(N.download, on && !!c.downloadText());
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
        logger.info('vizualyse_steam shutdown: ' + JSON.stringify(reason));
        if (this._stopSpeed) this._stopSpeed();
        clearTimeout(this._focusTimer);
        clearTimeout(this._screenTimer);
        this._control.hide();
        this._control.close();
        const bundle = this.rhmiApplication && this.rhmiApplication.getResourceBundle();
        this._shutdownPromise = Promise.resolve()
            .then(() => (this._qr.file && bundle ? this._retireQr(bundle, this._qr.file) : undefined))
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new SteamApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_steam failed to start: ' + (err && err.message));
});
