// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse_cluster - the iDrive page of the vizualyse-cluster tool:
 * whole-cluster themes drawn over the instrument cluster.
 *
 * One LT_State_Wide page, all of it usable with the iDrive controller: the
 * status; Choose with previews (the touch picker); one row per theme family
 * (pressing one puts it on the cluster and turns themes on); Sport or
 * Comfort (by the drive mode, always Sport, always Comfort); the car's strip
 * under the theme (shown or covered); themes on or off.
 *
 * The picker is the tool's: a preview of every theme drawn in the app area
 * (not the HMI's top bar or left strip), read by touch. The HMI still gets
 * every touch on it, so Choose first opens the screen state
 * (ST_..._VizualyseClusterScreen: a title and a label, nothing to press) and
 * the picker goes up once that state is visible; while it is up, every
 * button of the main page is disabled too (should the screen state not
 * open). It shows only while the state under it is visible and focused:
 * BACK (the arrow outside the picker), HOME, another app, or an HMI pop-up
 * taking the focus (a call, a warning) hides it.
 *
 * Only while parked: the app reads the car's speed once a second
 * (vehicle_speed.js) and hands it to the tool, which hides the picker above
 * 3 km/h and won't show it, and tries a theme on the cluster only at a
 * standstill. So the app holds the tool's control socket while it runs, not
 * only while its page shows. The structure follows vizualyse_steam.
 */
'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { ClusterControl } = require('./cluster_control.js');
const { watchSpeed } = require('./vehicle_speed.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_VizualyseCluster';
const SCREEN_NAME = 'ST_OnlineApps_VizualyseClusterScreen';
/* how long the screen state may take to show after openState */
const SCREEN_OPEN_MS = 3000;
const N = {
    status: 'clusterStatus', pick: 'clusterPick',
    theme1: 'clusterTheme1', theme2: 'clusterTheme2', theme3: 'clusterTheme3', theme4: 'clusterTheme4',
    theme5: 'clusterTheme5', theme6: 'clusterTheme6', theme7: 'clusterTheme7', theme8: 'clusterTheme8',
    mode: 'clusterMode', cover: 'clusterCover', enable: 'clusterEnable',
};
const THEMES = [N.theme1, N.theme2, N.theme3, N.theme4, N.theme5, N.theme6, N.theme7, N.theme8];
/* an HMI pop-up takes the focus while the page stays visible; leaving or
 * switching states takes it too, just before 'visible' goes: wait this long
 * to tell them apart */
const FOCUS_LOST_MS = 300;
const PRESS_DEDUPE_MS = 400;
const ROW_CHARS = 90;

function oneRow(line) {
    const flat = String(line || '').replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? flat.slice(0, ROW_CHARS - 3) + '...' : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class ClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._screen = null;
        /* per state: visible, focused (assumed with visible until told otherwise) */
        this._st = { main: { visible: false, focused: false }, screen: { visible: false, focused: false } };
        this._wantScreen = false;
        this._shownOn = 'screen';
        this._themeIds = THEMES.map(() => null);
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._control = new ClusterControl({ log: logger });
        this._control.on('change', () => this._render());
        this._stopSpeed = null;

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error('vizualyse_cluster init failed: ' + (err && err.message)));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn('OnlineApp error: ' + (err && err.message)));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._setVisible(false);
        });
    }

    _appInitialized() {
        logger.info('vizualyse_cluster ' + this.getAppId() + ' v' + this._packageJson.version + ' starting');
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
        if (!this._screen) logger.warn('uiDescription has no ' + SCREEN_NAME + ': the picker goes over the main page');
        this._bind(N.pick, () => this._showPicker());
        THEMES.forEach((name, i) => this._bind(name, () => (this._themeIds[i] ? this._control.use(this._themeIds[i]) : true)));
        this._bind(N.mode, () => this._control.nextMode());
        this._bind(N.cover, () => this._control.cover(!this._control.covered()));
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
            this._render();
        });
        this._watchState(this._state, 'main');
        if (this._screen) this._watchState(this._screen, 'screen');
        return Promise.resolve(this._state.updateResources()).then(() => {
            logger.info('page ready: ' + names.length + ' components found');
            this._render();
        });
    }

    /* visible / focus of one of the two states */
    _watchState(state, key) {
        state.on('visible', (event) => {
            const visible = isTrue(event && event.visible);
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
     * time): the app is visible while either state is, and the picker stays
     * up only while the state it was shown on is visible and focused (BACK
     * from the screen state brings the main page back: that hides it too). */
    _recheck() {
        clearTimeout(this._focusTimer);
        this._focusTimer = setTimeout(() => {
            const m = this._st.main, sc = this._st.screen;
            this._setVisible(m.visible || sc.visible);
            const on = this._st[this._shownOn];
            if (!(on.visible && on.focused) && !this._wantScreen && this._control.hide()) logger.info('our page left or covered (a pop-up?): picker hidden');
        }, FOCUS_LOST_MS);
    }

    /* Choose: the screen state first, the picker once it is visible; without
     * it (no such state, or the HMI won't open it) the picker goes over the
     * main page, whose buttons are disabled meanwhile (_render). */
    _showPicker() {
        const rhmi = this.rhmiApplication, screen = this._screen;
        if (!screen) return this._showOn('main');
        if (this._st.screen.visible) return this._showOn('screen');
        if (!this._control.connected()) return false;
        if (this._control.moving()) return this._control.showPicker();   /* the tool says why */
        this._wantScreen = true;
        const fallback = (why) => {
            if (!this._wantScreen) return;
            this._wantScreen = false;
            logger.warn('screen state: ' + why + '; the picker goes over the main page');
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

    /* the picker up over one of our states ('main' or 'screen') */
    _showOn(key) {
        this._shownOn = key;
        return this._control.showPicker();
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
            if (handler() === false) logger.warn(name + ': the cluster themes tool is not connected');
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
        /* off our pages the picker must not cover whatever the HMI shows */
        if (!visible && this._control.hide()) logger.info('app left: picker hidden');
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
        const c = this._control, up = c.connected(), on = c.enabled();
        /* while the picker covers the page, nothing under it can be pressed */
        const covered = c.shown();
        this._write(N.status, c.statusText());
        this._write(N.pick, c.moving() ? 'Choose with previews (only while parked)' : 'Choose with previews (touch the screen)');
        this._write(N.mode, up ? c.modeText() : 'Sport or Comfort');
        this._write(N.cover, "The car's strip under the theme: " + (c.covered() ? 'covered (black)' : 'shown'));
        this._write(N.enable, 'Cluster themes: ' + (up ? (on ? 'on' : "off (the car's own cluster)") : 'not running'));
        this._setEnabled(N.pick, up && !covered && !c.moving());
        this._setEnabled(N.mode, up && !covered);
        this._setEnabled(N.cover, up && !covered);
        this._setEnabled(N.enable, up && !covered);
        const fams = up ? c.families().slice(0, THEMES.length) : [];
        THEMES.forEach((name, i) => {
            const f = fams[i];
            this._themeIds[i] = f ? f.family : null;
            this._show(name, !!f);
            if (!f) return;
            this._write(name, (on && c.theme() === f.family ? 'In use: ' : '') + f.title);
            this._setEnabled(name, !covered);
        });
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) return this._shutdownPromise;
        logger.info('vizualyse_cluster shutdown: ' + JSON.stringify(reason));
        if (this._stopSpeed) this._stopSpeed();
        clearTimeout(this._focusTimer);
        clearTimeout(this._screenTimer);
        this._control.hide();
        this._control.close();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info('destroyBundles: ' + (err && err.message))))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new ClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error('vizualyse_cluster failed to start: ' + (err && err.message));
});
