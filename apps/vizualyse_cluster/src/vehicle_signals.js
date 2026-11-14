// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The car's readings for the cluster themes, over SOME/IP, as the tool's
 * signal names (native/vizualyse-cluster/src/sim.js). Where each comes from,
 * its scaling and how sure that is: knowledge/vehicle-signals.md. Every
 * field below is in our unit's catalog (/etc/oap/someip/someip-interfaces.json,
 * I_21w12.2-1-4) with the access asked for; tools/check_signals.js checks
 * that against a copy of the catalog, and test_page.js that the manifest
 * asks for exactly these.
 *
 * Each interface: buildTypedProxy, init, waitUntilAvailable; each field
 * read once (getter), then subscribed (notifier), and fields with a getter
 * read again every `poll` ms (a parked car notifies nothing; TPMS may never
 * notify). One interface at a time, each step in a fresh tick (the native
 * binding deadlocks when its calls run inline beside the SDK's own:
 * idrive7-apps kit/runtime/signals.js).
 *
 * watch(someipBuilders, log, onSignals): onSignals({name: value, ...}) with
 * what changed, at most every SEND_MS, and everything known every FULL_MS
 * (the tool forgets a reading it hasn't heard for 2 s). A value the car
 * marks invalid is null (the theme shows --). Returns stop().
 */
'use strict';

const SEND_MS = 100;
const FULL_MS = 1000;   /* the tool forgets a reading after 2 s (SIGNAL_TTL_MS) */
const POLL_MS = 5000;

const V = 'de.bmw.infotainment.vehicle.';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const KOMBI = 'de.bmw.infotainment.KombiIF';

/* an enum that may arrive as its name or its number */
function en(v, items) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(items, v)) return items[v];
    return null;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round = (v, d) => (v == null ? null : Math.round(v * Math.pow(10, d)) / Math.pow(10, d));

const GEAR = { INITIALISIERUNG: 0, N: 1, R: 2, P: 3, NP: 4, _1: 5, _2: 6, _3: 7, _4: 8, _5: 9, _6: 10, _7: 11, _8: 12, _9: 13, SIGNAL_UNGUELTIG: 15 };
const PROGRAM = { DUNKELSCHALTUNG: 0, S_MINUS_PROGRAMM: 1, M_MINUS_PROGRAMM: 2, L_MINUS_PROGRAMM: 3, C_MINUS_PROGRAMM: 4, B_PROGRAMM: 5, SIGNAL_UNGUELTIG: 7 };
const MODE = { SPORT_DYNAMIC: 1, SPORT_EXPERT: 2, SPORT_INDIVIDUAL: 3, COMFORT: 4, COMFORT_PLUS: 5, COMFORT_INDIVIDUAL: 6, ECO_PRO_EFFICIENT: 7,
    ECO_PRO_PLUS: 8, ECO_PRO_INDIVIDUAL: 9, ADAPTIVE: 10, PHEV_SPORT_STANDARD: 15, PHEV_SPORT_INDIVIDUAL: 16, PHEV_HYBRID_STANDARD: 17,
    PHEV_HYBRID_ECO: 18, PHEV_HYBRID_COMFORT: 19, PHEV_ELECTRIC_STANDARD: 20, PHEV_ELECTRIC_INDIVIDUAL: 21, PHEV_BATTERYCONTROL: 22,
    PHEV_SPORT_PLUS: 23, EASE_MODUS: 24, TRACTION_ASSIST: 27 };
/* the drive mode's word: SPORT picks the Sport theme, anything else Comfort */
function modeWord(n) {
    if ([1, 2, 3, 15, 16, 23].indexOf(n) >= 0) return 'SPORT';
    if ([7, 8, 9].indexOf(n) >= 0) return 'ECO PRO';
    if ([17, 18, 19].indexOf(n) >= 0) return 'HYBRID';
    if ([20, 21].indexOf(n) >= 0) return 'ELECTRIC';
    if (n === 10) return 'ADAPTIVE';
    if ([4, 5, 6, 22, 24, 27].indexOf(n) >= 0) return 'COMFORT';
    return null;   /* 0, 61-63: none (sent as the car switches off): keep the last */
}
const SPEED_BC = { DEFAULT: 0, KM_S_H__KM: 1, MPH__MLS: 2, SIGNAL_UNGUELTIG: 3 };
const CONS_BC = { DEFAULT: 0, VERBRAUCH_IN_L_S_100KM: 1, VERBRAUCH_IN_MPG_UK: 2, VERBRAUCH_IN_MPG_US: 3, VERBRAUCH_IN_KM_S_L: 4, SIGNAL_UNGUELTIG: 7 };
const AIR = { DEFAULT: 0, BAR: 1, KPA: 2, PSI: 3, SIGNAL_UNGUELTIG: 7 };
const TEMP = { DEFAULT: 0, C: 1, F: 2, SIGNAL_UNGUELTIG: 3 };
const TYRES = ['FLH', 'FRH', 'RLH', 'RRH'];

/* A tyre pressure in bar from the TPMS raw value (x 0.1 in the car's unit):
 * the unit from Vehicle's units status when read, else from the size (bar
 * about 1.5-4, psi 20-60, kPa 150-400). */
function tyreBar(raw, unit) {
    if (typeof raw !== 'number' || raw >= 65532) return null;
    const v = raw * 0.1;
    if (unit === AIR.KPA || (unit == null && v > 100)) return v / 100;
    if (unit === AIR.PSI || (unit == null && v > 10)) return v / 14.5038;
    return v;
}
function tyreC(raw, unit) {
    if (typeof raw !== 'number' || raw >= 65535) return null;
    const v = raw - 40;
    return unit === TEMP.F ? (v - 32) / 1.8 : v;
}

/*
 * The readings. access: what the manifest asks for ("rs": getter and
 * notifier, "s": notifier only; the catalog's access decides). take(v, s):
 * set s.<signal> from the field's value v (s also holds what other fields
 * gave, for readings made of two). sure: false where the scaling is a
 * best guess (logged raw for checking against the car's own display).
 */
const READINGS = [
    /* the speed, subscribed for a smooth needle (vehicle_speed.js also polls it for the parked gate) */
    { iface: V + 'Vehicle2', field: 'statusCarSpeed2', access: 'rs',
        take(v, s) { const r = num(v.speedVehicleCentreOfGravity); s.kmh = r == null || r === 65535 ? null : round(r / 64, 1); } },
    { iface: V + 'CDS', field: 'statusEngineSpeed2', access: 'rs',
        take(v, s) { const r = num(v.actualValueRPMEngineCrankshaft); s.rpm = r == null || r === 65535 ? null : Math.round(r * 0.25); power(s); } },
    { iface: V + 'CDS', field: 'statusEngineTemperature', access: 'rs', poll: POLL_MS,
        take(v, s) {
            const o = num(v.temperatureEngineOilDrive), c = num(v.temperatureEngineDrive);
            s.oilC = o == null || o === 255 ? null : o - 48;
            s.coolantC = c == null || c === 255 ? null : c - 48;
        } },
    { iface: V + 'CDS2', field: 'statusLateralAccelerationMassCenter', access: 'rs',
        take(v, s) { const r = num(v.lateralAccelerationCentreOfGravity); s.gLat = r == null || r === 65535 ? null : round((r * 0.002 - 65) / 9.80665, 3); } },
    { iface: V + 'CDS2', field: 'statusLongitudinalAccelerationMassCenter', access: 'rs',
        take(v, s) { const r = num(v.longitudinalAccelerationCentreOfGravity); s.gLon = r == null || r === 65535 ? null : round((r * 0.002 - 65) / 9.80665, 3); } },
    { iface: 'de.bmw.infrastructure.VehicleInformation', field: 'DataPowerTrain2', access: 's',
        take(v, s) {
            const g = en(v.statusGearSelectionDrive, GEAR);
            if (g == null || g === 0 || g === 15) { s.gear = null; s.gearPos = null; return; }
            s.gear = g >= 5 && g <= 13 ? g - 4 : 0;
            s.gearPos = g === 2 ? 'R' : g === 3 || g === 4 ? 'P' : g === 1 ? 'N' : 'D';
        } },
    { iface: 'de.bmw.infotainment.misc.MDrive', field: 'dataDisplayGearbox', access: 's',
        take(v, s) { const p = en(v.displayProgramGearbox, PROGRAM); s.gearMode = p === 1 ? 'S' : p === 2 ? 'M' : p === 0 ? 'D' : null; } },
    { iface: FES, field: 'statusFESVehicleDynamicSwitchHMI', access: 'rs', poll: POLL_MS,
        take(v, s) { const w = modeWord(en(v.actualValueModeDrivingExperience, MODE)); if (w) s.driveMode = w; } },
    /* engine power from crankshaft torque and rpm: kW = Nm x rpm / 9549, x 1.341 hp */
    { iface: FES, field: 'statusActualValueTorque2', access: 'rs',
        take(v, s) {
            const t = num(v.actualValueTorqueCrankshaft);
            s._torqueNm = t == null || t >= 4095 ? null : t * 0.5 - 1023.5;
            power(s);
        } },
    { iface: FES, field: 'statusSwitchDriveDynamicSport2', access: 'rs', sure: false,
        take(v, s) { const b = num(v.displayBoostPressure); s.boostBar = b == null || b === 255 ? null : round(b * 0.01, 2); } },
    { iface: 'de.bmw.powertrain.AcceleratorPedal', field: 'AngleAcceleratorPedal', access: 's', sure: false,
        take(v, s) { const a = num(v.actualValueAngleAcceleratorPedal); s.throttle = a == null || a >= 65535 ? null : round(Math.min(1, Math.max(0, a * 0.025 / 100)), 3); } },
    { iface: 'de.bmw.infrastructure.EnvironmentalInformation', field: 'ExteriorTemperature', access: 's', manifest: false,
        take(v, s) { const t = num(v.temperatureExterior); s.outsideC = t == null || t === 255 ? null : t * 0.5 - 40; } },
    { iface: KOMBI, field: 'statusRangeTankStatus', access: 'rs', poll: POLL_MS,
        take(v, s) {
            const f = num(v.fluidLevelFuelTank), r = num(v.range), o = num(v.mileageKilometre);
            s.fuelL = f == null || f >= 255 ? null : f;
            s.rangeKm = r == null || r >= 4095 ? null : r;
            s.odoKm = o == null || o >= 16777215 ? null : o;
        } },
    { iface: KOMBI, field: 'displayRangeElectricVehicle', access: 'rs', poll: POLL_MS, sure: false,
        take(v, s) { const r = num(v.displayRangeElectricVehicle); s.evRangeKm = r == null || r >= 65535 ? null : r; } },
    { iface: 'de.bmw.infotainment.drivingexcitement.Efficiencytainment2', field: 'statusChargeOfBatteryHybrid', access: 'rs', poll: POLL_MS, sure: false,
        take(v, s) { const c = num(v.displayChargingConditionHighVoltageStorage); s.socPct = c == null || c > 100 ? null : c; } },
    { iface: KOMBI, field: 'statusBordcomputerTravelData', access: 'rs', poll: POLL_MS, sure: false,
        take(v, s) { const w = num(v.wayPassed); s.tripKm = w == null || w >= 65535 ? null : w; } },
    { iface: KOMBI, field: 'statusBordcomputerAverage', access: 'rs', poll: POLL_MS, sure: false,
        take(v, s) {
            const sp = num(v.speedAverage1BC1), co = num(v.consumptionAverage1BC1);
            const su = en(v.statusUnitOfMeasurementSpeedBC, SPEED_BC), cu = en(v.statusUnitOfMeasurementConsumptionBC, CONS_BC);
            const speed = sp == null || sp >= 65535 ? null : sp * 0.1;
            s.avgKmh = speed == null ? null : round(su === 2 ? speed * 1.609344 : speed, 1);
            const c = co == null || co >= 65535 ? null : co * 0.1;
            s.avgL100 = c == null || c === 0 ? null : round(cu === 2 ? 282.481 / c : cu === 3 ? 235.215 / c : cu === 4 ? 100 / c : c, 1);
        } },
    { iface: V + 'TPMS', field: 'statusTyrePressure', access: 'rs', poll: 10000,
        take(v, s) { s._tyreRaw = TYRES.map((t) => v['actualValuePressureTyre' + t]); tyres(s); } },
    { iface: V + 'TPMS', field: 'statusTyreTemperature', access: 'rs', poll: 10000,
        take(v, s) { s._tyreTempRaw = TYRES.map((t) => v['actualValueTemperatureTyre' + t]); tyres(s); } },
    /* the units the car shows (tyre pressure, temperature); Vehicle is "*" in the manifest */
    { iface: V + 'Vehicle', field: 'statusNewCurrentUnitsStatusExt', access: 'rs', poll: 30000, manifest: false,
        take(v, s) {
            s._airUnit = en(v.unitOfMeasurementAirPressure, AIR);
            s._tempUnit = en(v.unitOfMeasurementTemperature, TEMP);
            if (s._airUnit === 0 || s._airUnit === 7) s._airUnit = null;
            if (s._tempUnit === 0 || s._tempUnit === 3) s._tempUnit = null;
            tyres(s);
        } },
];
function power(s) {
    if (s._torqueNm === undefined) return;
    s.engineHp = s._torqueNm == null || s.rpm == null ? null : Math.max(0, Math.round(s._torqueNm * s.rpm / 9549 * 1.341));
}
function tyres(s) {
    const p = s._tyreRaw, t = s._tyreTempRaw;
    if (!p && !t) return;
    s.tyres = TYRES.map((x, i) => ({ bar: p ? round(tyreBar(p[i], s._airUnit), 2) : null, c: t ? round(tyreC(t[i], s._tempUnit), 0) : null }));
}

/* The manifest's proxies for the readings: { iface: { instances, attributes } }. */
function manifestProxies() {
    const out = {};
    READINGS.filter((r) => r.manifest !== false).forEach((r) => {
        const p = out[r.iface] = out[r.iface] || { instances: ['1'], attributes: {} };
        p.attributes[r.field] = r.access;
    });
    return out;
}

function watch(someipBuilders, log, onSignals) {
    const s = {};            /* every reading so far, and the _working values */
    const sent = {};         /* what the tool was last told */
    let stopped = false, timer = null, full = null;
    const timers = [], loggedRaw = {};
    const out = (all) => {
        const o = {};
        Object.keys(s).forEach((k) => {
            if (k[0] === '_') return;
            const v = s[k], j = JSON.stringify(v);
            if (all || sent[k] !== j) { o[k] = v; sent[k] = j; }
        });
        if (Object.keys(o).length) onSignals(o);
    };
    const soon = () => { if (!timer && !stopped) timer = setTimeout(() => { timer = null; out(false); }, SEND_MS); };
    const take = (r, v) => {
        if (stopped || !v || typeof v !== 'object') return;
        try { r.take(v, s); } catch (e) { log.warn('signals: ' + r.field + ': ' + (e && e.message)); return; }
        if (r.sure === false && !loggedRaw[r.field]) { loggedRaw[r.field] = true; log.info('signals: ' + r.field + ' raw ' + JSON.stringify(v) + ' (scaling unconfirmed)'); }
        soon();
    };
    /* every call into the binding queued, one at a time, each in a fresh tick */
    let queue = Promise.resolve();
    const native = (fn) => {
        const run = () => new Promise((ok, no) => setImmediate(() => { try { Promise.resolve(fn()).then(ok, no); } catch (e) { no(e); } }));
        const p = queue.then(run, run);
        queue = p.catch(() => {});
        return p;
    };
    const byIface = {};
    READINGS.forEach((r) => { (byIface[r.iface] = byIface[r.iface] || []).push(r); });
    let up = 0;
    Object.keys(byIface).forEach((iface) => {
        let proxy = null;
        native(() => someipBuilders.buildTypedProxy(iface, '1'))
            .then((p) => { proxy = p; return native(() => p.init()); })
            /* each interface waits for its own provider: one that never comes holds up nothing else */
            .then(() => (proxy.waitUntilAvailable ? proxy.waitUntilAvailable() : null))
            .then(() => byIface[iface].reduce((c, r) => c.then(() => {
                if (stopped) return null;
                const f = proxy[r.field];
                if (!f) { log.warn('signals: ' + iface + ' has no ' + r.field + ' in this app\'s interface'); return null; }
                const get = () => native(() => f.getValue()).then((v) => take(r, v), () => {});
                return native(() => (f.subscribe ? f.subscribe((v) => take(r, v)) : null))
                    .catch((e) => log.warn('signals: subscribe ' + r.field + ': ' + (e && e.message)))
                    .then(() => {
                        if (r.access.indexOf('r') < 0) return null;
                        if (r.poll) timers.push(setInterval(() => { if (!stopped) get(); }, r.poll));
                        return get();
                    });
            }), Promise.resolve()))
            .then(() => { if (++up === Object.keys(byIface).length && !stopped) log.info('signals: all ' + up + ' interfaces up'); })
            .catch((e) => log.warn('signals: ' + iface + ' unavailable: ' + (e && e.message)));
    });
    full = setInterval(() => out(true), FULL_MS);
    return () => { stopped = true; clearTimeout(timer); clearInterval(full); timers.forEach(clearInterval); };
}

module.exports = { watch, manifestProxies, READINGS, tyreBar, tyreC, modeWord, SEND_MS, FULL_MS };
