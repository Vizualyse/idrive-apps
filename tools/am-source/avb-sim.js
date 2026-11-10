// avb-sim.js: the head unit's side of AVB (AVBSourceSinkController -S MGU),
// for the emulator only. On the car the unit's PCM reaches the amplifier
// over AVB: the audio manager's route for an entertainment source runs
// SmartXbar -> MGU_GW_x_SINK -> AVB_MGU_GW_x_SOURCE (this side) ->
// AVB_RAM_GW_x_SINK (the amplifier's; BMW's AVBSourceSinkControllerRAMsim
// plays it) -> InputA_Main. The real controller needs the AVB stack and is
// masked in the emulator; without this side every route is "no route found".
//
// Offers AVBSource and AVBSink instance "MGU", registers the unit's gateway
// sources and sinks with the audio manager's AVB routing plugin, says they
// are available, and acknowledges every request.
//
//   node avb-sim.js IFACEDIR   (as root; runs as ent_avbsourcesinkcontroller
//   4033:4030, the only uid the unit's policy lets offer AVBSource / AVBSink)
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');
var dir = process.argv[2];
function iface(n) { return require(path.resolve(dir, n + '.json')); }
function log(s) { console.log(new Date().toISOString().slice(11, 23) + ' avb: ' + s); }
var T = 15000, INST = 3; // instanceIDs: MGU = 3

if (process.getuid() === 0) { process.setgroups([4030]); process.setgid(4030); process.setuid(4033); }

// DOMAIN_AVB.bin: the gateway ends of each side (instanceIDs MGU = 3, the
// amplifier "1" = 1); class 7 = gateway. BMW's AVBSourceSinkControllerRAMsim
// offers the amplifier's side too, but never says its ends are available.
var SIDES = [
  { inst: 'MGU', id: 3,
    sources: { 646: 'AVB_MGU_GW_1_SOURCE', 647: 'AVB_MGU_GW_2_SOURCE', 653: 'AVB_MGU_GW_5_SOURCE',
      648: 'AVB_MGU_GW_3_SOURCE_ENCODED', 649: 'AVB_MGU_GW_4_SOURCE_ENCODED', 658: 'AVB_MGU_GW_5_SOURCE_ENCODED', 659: 'AVB_MGU_GW_6_SOURCE_ENCODED' },
    sinks: { 644: 'AVB_MGU_GW_1_SINK', 645: 'AVB_MGU_GW_2_SINK', 646: 'AVB_MGU_GW_3_SINK',
      647: 'AVB_MGU_GW_4_SINK_ENCODED', 648: 'AVB_MGU_GW_5_SINK_ENCODED', 658: 'AVB_MGU_GW_6_SINK_ENCODED' } },
  { inst: '1', id: 1,
    sources: { 640: 'AVB_RAM_GW_1_SOURCE', 641: 'AVB_RAM_GW_2_SOURCE', 642: 'AVB_RAM_GW_3_SOURCE',
      643: 'AVB_RAM_GW_4_SOURCE', 644: 'AVB_RAM_GW_5_SOURCE', 645: 'AVB_RAM_GW_6_SOURCE' },
    sinks: { 640: 'AVB_RAM_GW_1_SINK', 641: 'AVB_RAM_GW_2_SINK', 642: 'AVB_RAM_GW_3_SINK', 643: 'AVB_RAM_GW_4_SINK' } }
];
var AV = { availability: 'A_AVAILABLE', availabilityReason: 0 };

function later(svc, ev, payload) {
  setTimeout(function () { svc.fire(ev, payload).catch(function (e) { log(ev + ' failed: ' + e); }); }, 10);
}
function ok(p) { return { handle: p.handle, amError: 'E_OK' }; }

// one side's AVBSource and AVBSink: acknowledge everything
function impls(side) {
  function ack(which, ev, build, ret) {
    return function (p) {
      log(side.inst + ' ' + ev.replace(/^ack/, '') + ' ' + JSON.stringify(p));
      later(side[which], ev, build(p));
      return Promise.resolve(ret || {});
    };
  }
  var abort = function (p) { log(side.inst + ' abort ' + JSON.stringify(p)); return Promise.resolve({}); };
  return {
    src: {
      abort: abort,
      setSourceSoundProperties: ack('srcSvc', 'ackSetSourceSoundProperties', ok),
      setSourceVolume: ack('srcSvc', 'ackSetSourceVolumeChange', function (p) { return { handle: p.handle, volume: p.volume, amError: 'E_OK' }; }),
      setSourceNotificationConfiguration: ack('srcSvc', 'ackSourceNotificationConfiguration', ok),
      setSourceState: ack('srcSvc', 'ackSetSourceState', ok),
      startStream: ack('srcSvc', 'ackStartStream', ok, { amError: 'E_OK' }),
      stopStream: ack('srcSvc', 'ackStopStream', ok, { amError: 'E_OK' })
    },
    snk: {
      abort: abort,
      setSinkSoundProperties: ack('snkSvc', 'ackSetSinkSoundProperties', ok),
      setSinkVolume: ack('snkSvc', 'ackSetSinkVolumeChange', function (p) { return { handle: p.handle, volume: p.volume, amError: 'E_OK' }; }),
      setSinkNotificationConfiguration: ack('snkSvc', 'ackSinkNotificationConfiguration', ok),
      connect: ack('snkSvc', 'ackConnect', ok),
      disconnect: ack('snkSvc', 'ackDisconnect', function (p) { return { handle: p.handle, connectionID: p.connectionID, amError: 'E_OK' }; })
    }
  };
}

function proxy(name, inst) {
  return someip.buildProxy(iface(name), inst).then(function (p) {
    return new Promise(function (resolve, fail) {
      var t = setTimeout(function () { fail(new Error(name + ' not available')); }, T);
      p.init().then(function () { return p.subscribeToAvailability(function (up) { if (up) { clearTimeout(t); resolve(p); } }); });
    });
  });
}

function offer(side) {
  var i = impls(side);
  return someip.registerService(iface('AVBSource'), side.inst, i.src)
    .then(function (s) { side.srcSvc = s; return s.init(); })
    .then(function () { return someip.registerService(iface('AVBSink'), side.inst, i.snk); })
    .then(function (s) { side.snkSvc = s; return s.init(); })
    .then(function () { log('offering AVBSource / AVBSink ' + side.inst); });
}

// registerSource's reply carries a 6-byte MAC that someip.node can't decode
// ("macAdress: Buffer overflow"): the audio manager has registered the
// source by then, so that error is expected
function register(rp, side) {
  var p = Promise.resolve();
  Object.keys(side.sinks).forEach(function (id) {
    p = p.then(function () {
      return rp.callMethod('registerSink', { instanceID: side.id, sinkData: {
        sinkID: +id, name: side.sinks[id], domainID: 3, sinkClassID: 7, volume: 0, visible: false, available: AV,
        muteState: 'MS_UNMUTED', mainVolume: 0, listSoundProperties: [], listConnectionFormats: [1, 2], listMainSoundProperties: [],
        listMainNotificationConfigurations: [], listNotificationConfigurations: [] } }, T);
    }).then(function (r) { log('registerSink ' + id + ' ' + JSON.stringify(r)); }, function (e) { log('registerSink ' + id + ': ' + e); });
  });
  Object.keys(side.sources).forEach(function (id) {
    p = p.then(function () {
      return rp.callMethod('registerSource', { instanceID: side.id, sourceData: {
        sourceID: +id, domainID: 3, name: side.sources[id], sourceClassID: 7, sourceState: 'SS_OFF', volume: 0, visible: false,
        available: AV, interruptState: 'IS_OFF', listSoundProperties: [], listConnectionFormats: [1, 2], listMainSoundProperties: [],
        listMainNotificationConfigurations: [], listNotificationConfigurations: [] } }, T);
    }).then(function (r) { log('registerSource ' + id + ' ' + JSON.stringify(r)); }, function (e) { log('registerSource ' + id + ': ' + e.message); });
  });
  return p;
}

function fireAvailable() {
  var all = [];
  SIDES.forEach(function (side) {
    Object.keys(side.sources).forEach(function (id) { all.push(side.srcSvc.fire('sourceAvailablityStatusChange', { sourceID: +id, availability: AV }).catch(function () {})); });
    Object.keys(side.sinks).forEach(function (id) { all.push(side.snkSvc.fire('sinkAvailablityStatusChange', { sinkID: +id, availability: AV }).catch(function () {})); });
  });
  return Promise.all(all);
}

setImmediate(function () {
  SIDES.reduce(function (p, side) { return p.then(function () { return offer(side); }); }, Promise.resolve())
    .then(function () { return proxy('AVBRoutingPlugin', '1'); })
    .then(function (rp) { return SIDES.reduce(function (p, side) { return p.then(function () { return register(rp, side); }); }, Promise.resolve()); })
    .then(fireAvailable)
    .then(function () { log('available'); setInterval(fireAvailable, 5000); process.on('SIGTERM', function () { process.exit(0); }); })
    .catch(function (e) { log('failed: ' + (e && e.stack || e)); process.exit(1); });
});
