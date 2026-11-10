// domain-sim.js: an audio routing domain the emulator lacks, for the
// emulator only. Each one offers RoutingControl under the domain's instance,
// registers the domain with the audio manager, and acknowledges every
// request with E_OK.
//
//   ram      DOMAIN_RAM, instance "1": the amplifier, another ECU on the
//            car. The audio manager's lifecycle waits for it ("got Ram
//            register"); without it MediaSink_Front (1024) "is not started".
//            Sink volumes arriving here are the iDrive volume as the
//            amplifier gets it: each is logged.
//   encoded  DOMAIN_MGU_ENCODED: mediaapp's on the car, which the emulator's
//            mediaapp never offers (it logs nothing about why); the domain
//            of MediaSink_Front. Its sinks are marked available.
//
//   node domain-sim.js IFACEDIR ram|encoded   (as root; runs as ent_mapp
//   4100:4150, whose policy lets it offer RoutingControl to the audio manager)
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');
var dir = process.argv[2];
var DOMAINS = {
  // DOMAIN_RAM.bin: MainSink, InputA/B_Main, RAM_GW_1..6_SINK; RAM_GW_1..4_SOURCE
  // (the amplifier's ends of the AVB gateways from the unit)
  ram: { name: 'DOMAIN_RAM', inst: '1', node: 'RAM', sinks: [1, 129, 130, 139, 140, 141, 142, 143, 144], sources: [142, 143, 144, 145] },
  encoded: { name: 'DOMAIN_MGU_ENCODED', inst: 'DOMAIN_MGU_ENCODED', node: 'MGU', sinks: [1024], sources: [] }
};
var D = DOMAINS[process.argv[3] || 'ram'];
if (!D) { console.error('domain-sim.js IFACEDIR ram|encoded'); process.exit(64); }
function iface(n) { return require(path.resolve(dir, n + '.json')); }
function log(s) { console.log(new Date().toISOString().slice(11, 23) + ' ' + D.name + ': ' + s); }
var T = 15000;

if (process.getuid() === 0) { process.setgroups([4150]); process.setgid(4150); process.setuid(4100); }

// RoutingControl method -> its ack event and how to build the payload
var ACKS = {
  asyncConnect: ['ackConnect', function (p) { return { handle: p.handle, connectionID: p.connectionID, amError: 'E_OK' }; }],
  asyncDisconnect: ['ackDisconnect', function (p) { return { handle: p.handle, connectionID: p.connectionID, amError: 'E_OK' }; }],
  asyncSetSinkVolume: ['ackSetSinkVolumeChange', function (p) { return { handle: p.handle, volume: p.volume, amError: 'E_OK' }; }],
  asyncSetSourceVolume: ['ackSetSourceVolumeChange', function (p) { return { handle: p.handle, volume: p.volume, amError: 'E_OK' }; }],
  asyncSetSourceState: ['ackSetSourceState', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetSinkSoundProperty: ['ackSetSinkSoundProperty', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetSinkSoundProperties: ['ackSetSinkSoundProperties', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetSourceSoundProperty: ['ackSetSourceSoundProperty', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetSourceSoundProperties: ['ackSetSourceSoundProperties', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetVolumes: ['ackSetVolumes', function (p) { return { handle: p.handle, listVolumes: p.volumes, amError: 'E_OK' }; }],
  asyncCrossFade: ['ackCrossFading', function (p) { return { handle: p.handle, hotSink: p.hotSink, amError: 'E_OK' }; }],
  asyncSetSinkNotificationConfiguration: ['ackSinkNotificationConfiguration', function (p) { return { handle: p.handle, amError: 'E_OK' }; }],
  asyncSetSourceNotificationConfiguration: ['ackSourceNotificationConfiguration', function (p) { return { handle: p.handle, amError: 'E_OK' }; }]
};

var service;
var impl = {
  asyncAbort: function (p) { log('asyncAbort ' + JSON.stringify(p)); return Promise.resolve({}); },
  setDomainState: function (p) { log('setDomainState ' + JSON.stringify(p)); return Promise.resolve({ amError: 'E_OK' }); }
};
Object.keys(ACKS).forEach(function (m) {
  impl[m] = function (p) {
    log(m + ' ' + JSON.stringify(p));
    var ev = ACKS[m][0], payload = ACKS[m][1](p);
    setTimeout(function () {
      service.fire(ev, payload).catch(function (e) { log(ev + ' failed: ' + e); });
    }, 10);
    return Promise.resolve({});
  };
});

function proxy(name, inst) {
  return someip.buildProxy(iface(name), inst).then(function (p) {
    return new Promise(function (ok, fail) {
      var t = setTimeout(function () { fail(new Error(name + ' not available')); }, T);
      p.init().then(function () { return p.subscribeToAvailability(function (up) { if (up) { clearTimeout(t); ok(p); } }); });
    });
  });
}

setImmediate(function () {
  someip.registerService(iface('RoutingControl'), D.inst, impl)
    .then(function (s) { service = s; return s.init(); })
    .then(function () { log('offering RoutingControl ' + D.inst); return proxy('RoutingControlObserver', '1'); })
    .then(function (obs) {
      var dom = { domainID: 0, name: D.name, busname: 'CAPIRoutingPlugin', nodename: D.node, early: false, complete: false, state: 'DS_CONTROLLED' };
      return obs.callMethod('registerDomain', { domainData: dom, returnBusname: D.inst, returnInterface: D.inst }, T)
        .then(function (r) {
          log('registerDomain ' + JSON.stringify(r));
          return obs.callMethod('hookDomainRegistrationComplete', { domainID: r.domainID }, T);
        })
        .then(function () {
          log('registration complete');
          var av = { availability: 'A_AVAILABLE', availabilityReason: 0 };
          var p = D.sinks.reduce(function (p, id) {
            return p.then(function () { return obs.callMethod('hookSinkAvailablityStatusChange', { sinkID: id, availability: av }, T); });
          }, Promise.resolve());
          return D.sources.reduce(function (p, id) {
            return p.then(function () { return obs.callMethod('hookSourceAvailablityStatusChange', { sourceID: id, availability: av }, T); });
          }, p).then(function () { log('available: sinks ' + D.sinks.join(',') + ', sources ' + D.sources.join(',')); });
        });
    })
    .then(function () { process.on('SIGTERM', function () { process.exit(0); }); })
    .catch(function (e) { log('failed: ' + (e && e.stack || e)); process.exit(1); });
});
