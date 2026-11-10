// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * speakers.js off the car: the catalog -> schema conversion (as
 * tools/someip_iface.py, fixed-length arrays as ArrayF), then claim / lost /
 * release against a fake audio manager that behaves as the unit's did in the
 * emulator (knowledge/sound.md): a connect to MediaSink_Front replaces the
 * source there, CarLife's 287 connects only while marked available.
 *
 *   node platform/tool/speakers/<version>/test/speakers_test.js
 *
 * The real thing, in the emulator: tools/am-source/emu-test.sh.
 */
'use strict';
const path = require('path');
const { Speakers, schemaGen, DEVICE, CARPLAY } = require(path.join(__dirname, '..', 'speakers.js'));

let fails = 0;
function ok(what, cond, more) {
    console.log((cond ? 'ok   ' : 'FAIL ') + what + (more ? ': ' + more : ''));
    if (!cond) fails++;
}

// ---- the schema ----
const cat = {
    datatypes: {
        'x.Id': { name: 'Id', type: 'typedef', dataRef: 'UInt16' },
        'x.Avail': { name: 'Avail', type: 'enum', enumWidth: 1, items: { A_AVAILABLE: 1, A_UNAVAILABLE: 2 } },
        'x.Mac': { name: 'Mac', type: 'array', dataRef: 'UInt8', dimension: 1, arrayLengthWidth: 0, arrayMaxLength: 6, arrayMinLength: 6 },
        'x.List': { name: 'List', type: 'array', dataRef: 'x.Id', dimension: 1 },
        'x.S': { name: 'S', type: 'struct', members: [{ name: 'id', dataRef: 'x.Id' }, { name: 'a', dataRef: 'x.Avail' }, { name: 'mac', dataRef: 'x.Mac' }] }
    },
    interfaces: {
        'x.I': { name: 'I', serviceId: 1, version: { major: 1, minor: 0 },
            methods: { m: { methodId: 3, reliable: true, inputs: [{ name: 's', dataRef: 'x.S' }, { name: 'l', dataRef: 'x.List' }], outputs: [{ name: 'e', dataRef: 'x.Avail' }] } } }
    },
    instanceIDs: { 'x.I': { 1: 1 } }
};
const i = schemaGen(cat)('x.I');
const m = i.methods.m;
ok('schema: method id and reliable', m.id === 3 && m.reliable === true);
ok('schema: typedef to its primitive', m.schema.e[0].e[0].t === 'UInt16');
ok('schema: enum with width and items', m.schema.e[0].e[1].t === 'Enum' && m.schema.e[0].e[1].w === 1 && m.schema.e[0].e[1].e.A_UNAVAILABLE === 2);
ok('schema: fixed-length array is ArrayF', JSON.stringify(m.schema.e[0].e[2]) === JSON.stringify({ n: 'mac', t: 'ArrayF', l: 6, e: { t: 'UInt8' } }),
    JSON.stringify(m.schema.e[0].e[2]));
ok('schema: plain array is ArrayD', m.schema.e[1].t === 'ArrayD' && m.schema.e[1].lw === undefined);
ok('schema: return value', m.retSchema.e[0].t === 'Enum');

// ---- a fake audio manager ----
function fakeAM() {
    const am = { available: { 287: false }, conns: [{ mainConnectionID: 1, sourceID: 1, sinkID: 1024, connectionState: 'CS_CONNECTED' }], next: 2, calls: [] };
    const proxy = {
        init: () => Promise.resolve(),
        subscribeToAvailability: (cb) => { setImmediate(() => cb(true)); return Promise.resolve(); },
        waitUntilAvailable: () => Promise.resolve(),
        callMethod: (name, a) => {
            am.calls.push(name + ' ' + JSON.stringify(a));
            switch (name) {
                case 'getListMainConnections': return Promise.resolve({ listConnections: am.conns.map((c) => Object.assign({}, c)) });
                case 'hookSourceAvailablityStatusChange': am.available[a.sourceID] = a.availability.availability === 'A_AVAILABLE'; return Promise.resolve({});
                case 'connect': {
                    if (am.conns.some((c) => c.sourceID === a.sourceID && c.sinkID === a.sinkID)) return Promise.resolve({ mainConnectionID: 0, amError: 'E_ALREADY_EXISTS' });
                    const c = { mainConnectionID: am.next++, sourceID: a.sourceID, sinkID: a.sinkID, connectionState: 'CS_CONNECTING' };
                    am.conns = am.conns.filter((x) => x.sinkID !== a.sinkID).concat([c]);
                    if (a.sourceID !== 287 || am.available[287]) setTimeout(() => { c.connectionState = 'CS_CONNECTED'; }, 300);
                    return Promise.resolve({ mainConnectionID: c.mainConnectionID, amError: 'E_OK' });
                }
                case 'disconnect': am.conns = am.conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return Promise.resolve({ amError: 'E_OK' });
                default: return Promise.reject(new Error('unexpected ' + name));
            }
        }
    };
    am.someip = { buildProxy: () => Promise.resolve(proxy) };
    return am;
}
const front = (am) => am.conns.filter((c) => c.sinkID === 1024);

const fs = require('fs');
const os = require('os');
const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'speakers-')), 'speakers.json');
const catalog = { datatypes: {}, interfaces: {
    'org.genivi.am.commandinterface.CommandControl': { name: 'CommandControl', serviceId: 45088, version: { major: 1, minor: 0 }, methods: {} },
    'org.genivi.am.routinginterface.RoutingControlObserver': { name: 'RoutingControlObserver', serviceId: 45090, version: { major: 1, minor: 0 }, methods: {} }
}, instanceIDs: {} };
const dead = [];                    // pids the tests call dead
const make = (am, pid, more) => new Speakers(Object.assign({ someip: am.someip, catalog: catalog, record: record, pid: pid,
    alive: (p) => dead.indexOf(p) < 0, pollMs: 100, log: () => {} }, more || {}));
const holders = () => { try { return JSON.parse(fs.readFileSync(record, 'utf8')).holders; } catch (e) { return null; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const am = fakeAM();
const a = make(am, 101), b = make(am, 102);
let lost = 0;
a.on('lost', () => lost++);

a.claim()
    .then((dev) => {
        ok('claim: the device to play into', dev === DEVICE);
        ok('claim: CarLife on the front speakers, connected', front(am).length === 1 && front(am)[0].sourceID === 287 && front(am)[0].connectionState === 'CS_CONNECTED');
        ok('claim: marked available first', am.calls.findIndex((c) => /^hook/.test(c)) < am.calls.findIndex((c) => /^connect/.test(c)));
        ok('claim: recorded, with the radio to give back', JSON.stringify(holders()) === '[101]' && JSON.parse(fs.readFileSync(record, 'utf8')).previous === 1);
        return b.claim();
    })
    .then(() => {
        ok('a second tool: both hold, the radio still remembered', JSON.stringify(holders()) === '[101,102]' &&
            JSON.parse(fs.readFileSync(record, 'utf8')).previous === 1 && front(am).length === 1);
        return a.release();
    })
    .then(() => {
        ok('the first lets go: the other still plays', front(am)[0].sourceID === 287 && JSON.stringify(holders()) === '[102]');
        am.conns = am.conns.filter((c) => c.sourceID !== 287);       // the HMI took the speakers
        return wait(350);
    })
    .then(() => b.release())
    .then(() => {
        ok('the last lets go: the radio back, the record gone', front(am).length === 1 && front(am)[0].sourceID === 1 && holders() === null);
        ok('release: 287 unavailable again', am.available[287] === false);
        return a.claim();
    })
    .then(() => {
        am.conns = am.conns.filter((c) => c.sourceID !== 287);
        return wait(350);
    })
    .then(() => {
        ok('lost: emitted', lost === 1);
        return a.release();
    })
    .then(() => {
        // a tool dies holding the speakers: the next tool to start gives them back
        const c = make(am, 103);
        return c.claim().then(() => { dead.push(103); return make(am, 104).recover(); });
    })
    .then(() => {
        ok('recover: a dead holder\'s speakers given back', front(am)[0].sourceID === 1 && holders() === null);
        // a head unit restart: no record, the audio manager resumed CarLife
        am.conns = [{ mainConnectionID: 70, sourceID: 287, sinkID: 1024, connectionState: 'CS_CONNECTED' }];
        return make(am, 105).recover();
    })
    .then(() => {
        ok('recover: CarLife with no holder given back to the radio', front(am).length === 1 && front(am)[0].sourceID === 1);
        return make(am, 106).recover().then(() => ok('recover: nothing left over, nothing done', front(am)[0].sourceID === 1));
    })
    .then(() => {
        // the owner says no: 287 never connects; claimOr falls back to CarPlay's input and gives back
        am.conns = [{ mainConnectionID: 50, sourceID: 1, sinkID: 1024, connectionState: 'CS_CONNECTED' }];
        const refusing = { buildProxy: () => am.someip.buildProxy().then((p) => Object.assign({}, p, {
            callMethod: (n, x) => (n === 'hookSourceAvailablityStatusChange' ? Promise.resolve({}) : p.callMethod(n, x))
        })) };
        return make(am, 107, { someip: refusing, connectMs: 600 }).claimOr(CARPLAY).then((dev) => {
            ok('refused: claimOr falls back to CarPlay\'s input', dev === CARPLAY, dev);
            ok('refused: the radio given back, no holder left', front(am).length === 1 && front(am)[0].sourceID === 1 && holders() === null);
        });
    })
    .then(() => {
        // stopped while the claim is still under way: released once it ends, nothing left connected
        const d = make(am, 109);
        const claimed = d.claim();
        const released = d.release();
        return Promise.all([claimed, released]).then(() => {
            ok('release during a claim: waits, then gives back', front(am).length === 1 && front(am)[0].sourceID === 1 && holders() === null);
        });
    })
    .then(() => {
        // not a head unit (no someip.node): the fallback, nothing thrown
        return make(am, 108, { someip: { buildProxy: () => Promise.reject(new Error('no someip.node')) } }).claimOr(CARPLAY)
            .then((dev) => ok('no audio manager: claimOr falls back', dev === CARPLAY && holders() === null));
    })
    .then(() => {
        console.log(fails ? fails + ' failed' : 'all ok');
        process.exit(fails ? 1 : 0);
    })
    .catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
