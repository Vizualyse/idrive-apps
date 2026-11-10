// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The car's speakers for a tool's sound, with the iDrive volume on it and no
 * CarPlay phone needed (knowledge/sound.md, "Our own entertainment source").
 *
 * The audio manager makes a SmartXbar input a source only while its owner
 * says it is available. CarLife's media source (287, Baidu's projection,
 * China only) is registered on every car without a coding flag, and the
 * carlife process switches it on without a phone. claim() marks it
 * available and connects it to the front speakers (MediaSink_Front, 1024):
 * whatever then plays into DEVICE is the car's entertainment source, at the
 * iDrive volume. release() gives the speakers back to the source that had
 * them (the radio if none), which the audio manager would otherwise resume
 * after a restart in our place.
 *
 *   const { Speakers, CARPLAY } = require('./speakers.js');
 *   const sp = new Speakers({ log: (s) => console.log(s) });
 *   sp.recover();                       // at the tool's start
 *   sp.on('lost', () => ...);           // something else took the speakers
 *   sp.claimOr(CARPLAY).then((device) => play into device: pcm_play.py --device)
 *   ... sp.release()
 *
 * claimOr() falls back to CarPlay's input (how the tools played before) when
 * the speakers can't be had. Several tools may hold them at once
 * (/run/vizualyse-speakers.json): the last to release gives them back.
 * recover() gives back what a dead tool, or a head unit restart, left
 * claimed.
 *
 * As root (a tool), Node 8, the unit's /usr/lib/someip.node. The interface
 * schemas are made at start from the unit's own catalog
 * (/etc/oap/someip/someip-interfaces.json), as tools/someip_iface.py does
 * off the car: no BMW definitions are shipped.
 */
'use strict';
const EventEmitter = require('events');
const fs = require('fs');

const CATALOG = '/etc/oap/someip/someip-interfaces.json';
const SOURCE = 287;                 // CarLifeMedia
const SINK = 1024;                  // MediaSink_Front
const RADIO = 1;                    // FmDABCombined
const DEVICE = 'smartx:CarLifeMedia_CF_48_STEREO';
const IFACES = {
    CommandControl: 'org.genivi.am.commandinterface.CommandControl',
    RoutingControlObserver: 'org.genivi.am.routinginterface.RoutingControlObserver'
};
const T = 10000;
const AVAILABLE = { availability: 'A_AVAILABLE', availabilityReason: 0 };
const UNAVAILABLE = { availability: 'A_UNAVAILABLE', availabilityReason: 0 };

// ---- the catalog -> someip.node's interface JSON (tools/someip_iface.py) ----

const PRIM = ['UInt8', 'UInt16', 'UInt32', 'UInt64', 'Int8', 'Int16', 'Int32', 'Int64', 'Boolean', 'Float', 'Double',
    'Utf8D', 'Utf16D', 'Utf8', 'Utf16', 'ByteBuffer'];

function schemaGen(cat) {
    const types = cat.datatypes;
    function array(d) {
        // a fixed-length array (arrayLengthWidth 0) is someip.node's ArrayF
        if (d.arrayLengthWidth === 0 && d.arrayMaxLength !== undefined) return { t: 'ArrayF', l: d.arrayMaxLength };
        const o = { t: 'ArrayD' };
        if (d.arrayLengthWidth !== undefined && d.arrayLengthWidth !== 4) o.lw = d.arrayLengthWidth;
        if (d.arrayMinLength !== undefined) o.nl = d.arrayMinLength;
        if (d.arrayMaxLength !== undefined) o.xl = d.arrayMaxLength;
        return o;
    }
    function items(d) {
        const out = {};
        if (d.extends && types[d.extends]) Object.assign(out, items(types[d.extends]));
        return Object.assign(out, d.items);
    }
    function typ(ref) {
        if (PRIM.indexOf(ref) >= 0 || !types[ref]) {
            const o = { t: ref };
            if (ref === 'Utf16D' || ref === 'Utf16') o.bo = true;
            return o;
        }
        const d = types[ref];
        switch (d.type) {
            case 'typedef': return typ(d.dataRef);
            case 'enum': {
                const o = { t: 'Enum' };
                if (d.enumWidth !== undefined) o.w = d.enumWidth;
                o.e = items(d);
                return o;
            }
            case 'struct': return { t: 'Struct', e: d.members.map(named) };
            case 'array': { const o = array(d); o.e = typ(d.dataRef); return o; }
            case 'map': return { t: 'Map', k: mapped(d.keyDataRef), v: mapped(d.valueDataRef) };
            case 'union': return { t: 'Union', e: d.members.map(named) };
            default: throw new Error('type ' + d.type);
        }
    }
    function mapped(ref) {
        const o = typ(ref);
        if (types[ref] && (types[ref].type === 'array' || types[ref].type === 'typedef')) return Object.assign({ n: types[ref].name }, o);
        return o;
    }
    function named(m) {
        const o = { n: m.name };
        if (m.defaultValue !== undefined) o.d = m.defaultValue;
        let t = typ(m.dataRef);
        if (m.dimension) { const a = array(m); a.e = t; t = a; }
        Object.assign(o, t);
        if (m.bitWidth !== undefined) o.bw = m.bitWidth;
        return o;
    }
    function struct(args) { return args && args.length ? { t: 'Struct', e: args.map(named) } : {}; }
    return function iface(name) {
        const i = cat.interfaces[name];
        if (!i) throw new Error('the catalog has no ' + name);
        const out = { name: i.name, serviceId: i.serviceId, version: i.version, instances: cat.instanceIDs[name] || {}, methods: {} };
        Object.keys(i.methods || {}).forEach((mn) => {
            const m = i.methods[mn];
            const o = { id: m.methodId, schema: struct(m.inputs || []) };
            if (m.outputs) o.retSchema = struct(m.outputs);
            if (m.reliable) o.reliable = true;
            out.methods[mn] = o;
        });
        return out;
    };
}

// ---- the speakers ----

/* Who holds the speakers, across tools and restarts of a tool: the pids
 * that claimed them and the source to give back. In /run, so a head unit
 * restart clears it (and recover() then finds CarLife connected with no
 * holder: the audio manager resumed it as the last heard source). */
const RECORD = '/run/vizualyse-speakers.json';

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

class Speakers extends EventEmitter {
    /* opts: log(string), someip (the binding; default /usr/lib/someip.node),
     * catalog (path or parsed object), pollMs (the watch, 2000), connectMs
     * (how long claim() waits for the connection, 8000), record (the holders'
     * file), pid / alive(pid) (tests) */
    constructor(opts) {
        super();
        opts = opts || {};
        this.log = opts.log || (() => {});
        this.someip = opts.someip || null;
        this.catalog = opts.catalog || CATALOG;
        this.pollMs = opts.pollMs || 2000;
        this.connectMs = opts.connectMs || 8000;
        this.record = opts.record || RECORD;
        this.pid = opts.pid || process.pid;
        this.alive = opts.alive || isAlive;
        this.device = DEVICE;
        this.connectionID = 0;
        this.claimed = false;
        this.claiming = null;
        this.proxies = null;
        this.timer = null;
    }

    _read() {
        let r = null;
        try { r = JSON.parse(fs.readFileSync(this.record, 'utf8')); } catch (e) { return null; }
        if (!r || !Array.isArray(r.holders)) return null;
        r.holders = r.holders.filter((p) => p === this.pid || this.alive(p));
        return r;
    }

    _write(r) {
        try {
            if (r) fs.writeFileSync(this.record, JSON.stringify(r));
            else fs.unlinkSync(this.record);
        } catch (e) { if (r) this.log('speakers: ' + this.record + ': ' + e.message); }
    }

    _proxies() {
        if (this.proxies) return this.proxies;
        // someip.node wants its first calls from a fresh tick
        this.proxies = new Promise((r) => setImmediate(r)).then(() => {
            const someip = this.someip || (this.someip = require('/usr/lib/someip.node'));
            const cat = typeof this.catalog === 'string' ? JSON.parse(fs.readFileSync(this.catalog, 'utf8')) : this.catalog;
            const iface = schemaGen(cat);
            const one = (name) => someip.buildProxy(iface(IFACES[name]), '1').then((p) => new Promise((resolve, reject) => {
                // waitUntilAvailable alone never gives up on a service that isn't offered
                const t = setTimeout(() => reject(new Error(name + ' not available')), T);
                p.init()
                    .then(() => p.subscribeToAvailability((up) => { if (up) { clearTimeout(t); resolve(p); } }))
                    .then(() => p.waitUntilAvailable(T))
                    .then(() => { clearTimeout(t); resolve(p); }, () => {});
            }));
            return Promise.all([one('CommandControl'), one('RoutingControlObserver')]);
        }).then((p) => ({ cc: p[0], obs: p[1] }));
        this.proxies.catch(() => { this.proxies = null; });
        return this.proxies;
    }

    _connections(cc) {
        return cc.callMethod('getListMainConnections', {}, T).then((r) => r.listConnections || []);
    }

    _setAvailable(obs, on) {
        return obs.callMethod('hookSourceAvailablityStatusChange', { sourceID: SOURCE, availability: on ? AVAILABLE : UNAVAILABLE }, T);
    }

    /* The speakers are ours once this resolves (with the device to play
     * into); rejects if the audio manager doesn't connect us within
     * connectMs, and then gives the speakers back. */
    claim() {
        if (this.claiming) return this.claiming;
        this.claiming = this._claim().then((dev) => { this.claiming = null; return dev; }, (e) => {
            this.claiming = null;
            this.log('speakers: claim failed: ' + (e && e.message || e));
            return this.release().then(() => { throw e; });
        });
        return this.claiming;
    }

    _claim() {
        let px;
        return this._proxies().then((p) => { px = p; return this._connections(px.cc); })
            .then((list) => {
                const r = this._read() || { holders: [], previous: 0 };
                if (!r.holders.filter((p) => p !== this.pid).length) {
                    // nobody else holds them: what plays now is what we give back
                    const other = list.filter((c) => c.sinkID === SINK && c.sourceID !== SOURCE)[0];
                    if (other) r.previous = other.sourceID;
                }
                if (r.holders.indexOf(this.pid) < 0) r.holders.push(this.pid);
                this._write(r);
                this.claimed = true;
                return this._setAvailable(px.obs, true);
            })
            .then(() => px.cc.callMethod('connect', { sourceID: SOURCE, sinkID: SINK }, T))
            .then((r) => {
                if (r.amError !== 'E_OK' && r.amError !== 'E_ALREADY_EXISTS') throw new Error('connect: ' + r.amError);
                return this._waitConnected(px.cc, Date.now() + this.connectMs);
            })
            .then((id) => {
                this.connectionID = id;
                const r = this._read();
                this.log('speakers: ours (connection ' + id + ', gives back source ' + ((r && r.previous) || RADIO) + ')');
                this._watch(px.cc);
                return DEVICE;
            });
    }

    /* claim(), or the fallback device (CarPlay's input, as before) when the
     * speakers can't be had: never rejects. */
    claimOr(fallback) {
        return this.claim().catch(() => {
            this.log('speakers: playing into ' + fallback + ' instead');
            return fallback;
        });
    }

    _waitConnected(cc, until) {
        return this._connections(cc).then((list) => {
            const c = list.filter((x) => x.sourceID === SOURCE && x.sinkID === SINK)[0];
            if (c && c.connectionState === 'CS_CONNECTED') return c.mainConnectionID;
            if (Date.now() > until) throw new Error('not connected: ' + (c ? c.connectionState : 'no connection'));
            return new Promise((r) => setTimeout(r, 250)).then(() => this._waitConnected(cc, until));
        });
    }

    _watch(cc) {
        clearInterval(this.timer);
        let busy = false;
        this.timer = setInterval(() => {
            if (busy) return;
            busy = true;
            this._connections(cc).then((list) => {
                const c = list.filter((x) => x.sourceID === SOURCE && x.sinkID === SINK)[0];
                if (this.connectionID && (!c || c.connectionState === 'CS_DISCONNECTED')) {
                    this.log('speakers: lost (' + (c ? c.connectionState : 'connection gone') + ')');
                    clearInterval(this.timer);
                    this.connectionID = 0;
                    this.emit('lost');
                }
            }, () => {}).then(() => { busy = false; });
        }, this.pollMs);
    }

    _giveBack(px, previous) {
        const step = (what, p) => p.catch((e) => this.log('speakers: ' + what + ': ' + (e && e.message || e)));
        return this._connections(px.cc)
            .then((list) => {
                const ours = list.filter((c) => c.sourceID === SOURCE && c.sinkID === SINK)[0];
                return ours ? step('disconnect', px.cc.callMethod('disconnect', { mainConnectionID: ours.mainConnectionID }, T)) : null;
            })
            .then(() => step('unavailable', this._setAvailable(px.obs, false)))
            .then(() => step('give back', px.cc.callMethod('connect', { sourceID: previous || RADIO, sinkID: SINK }, T)))
            .then(() => this.log('speakers: given back to source ' + (previous || RADIO)));
    }

    /* Lets go of the speakers; the last holder gives them back. During a
     * claim, once it has ended. Never rejects. */
    release() {
        if (this.claiming) return this.claiming.then(() => this.release(), () => {});
        clearInterval(this.timer);
        this.timer = null;
        this.connectionID = 0;
        if (!this.claimed) return Promise.resolve();
        this.claimed = false;
        const r = this._read() || { holders: [], previous: 0 };
        r.holders = r.holders.filter((p) => p !== this.pid);
        if (r.holders.length) {
            this._write(r);
            this.log('speakers: released; still held by ' + r.holders.join(', '));
            return Promise.resolve();
        }
        this._write(null);
        if (!this.proxies) return Promise.resolve();
        return this.proxies.then((px) => this._giveBack(px, r.previous))
            .catch((e) => this.log('speakers: release: ' + (e && e.message || e)));
    }

    /* At a tool's start: speakers left claimed by a process that is gone, or
     * CarLife connected with no holder at all (the audio manager resumed it
     * after a head unit restart), are given back. Never rejects. */
    recover() {
        const r = this._read();
        if (r && r.holders.filter((p) => p !== this.pid).length) return Promise.resolve();
        return this._proxies().then((px) => this._connections(px.cc).then((list) => {
            const stale = list.filter((c) => c.sourceID === SOURCE && c.sinkID === SINK)[0];
            if (!r && !stale) return;
            this.log('speakers: left claimed (' + (r ? 'its holder is gone' : 'no holder') + '): giving them back');
            this._write(null);
            return this._giveBack(px, r && r.previous);
        })).catch((e) => this.log('speakers: recover: ' + (e && e.message || e)));
    }
}

module.exports = { Speakers, schemaGen, DEVICE, SOURCE, SINK, RADIO, CARPLAY: 'smartx:CarPlayMain_CF_48_STEREO' };
