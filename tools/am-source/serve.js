// serve.js (amsrc.js serve): stand in for a PCM source's owner, the way the
// media app or the carplay process does for theirs.
//
// The routing adapter (AlsaRoutingAdapters, DOMAIN_MGU) asks each source's
// owner (AmSourceControl, one instance per owner) before it switches a
// source on, and takes the source's availability from the owner's
// SourceAvailabilities. We offer an owner instance nobody on our car provides
// (the CD's by default), say our source is available, acknowledge every
// request, and register the source with the audio manager (coding leaves it
// out). The connect itself is root's (amsrc.js connect).
//
// Runs as ent_mapp (4100:4150): the unit's vsomeip policy lets that uid offer
// AmSourceControl and call the routing observer, and lets the routing adapter
// (4032) call it. Nothing in /etc changes.
//
//   --src=281 --owner=EntertainmentAudioCDFront --name=AudioCD_Front
//   --class=1 --format=1 --uid=4100 --gid=4150 --no-register
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

var DEFAULTS = {
  281: { owner: 'EntertainmentAudioCDFront', name: 'AudioCD_Front' },
  286: { owner: 'SdarsIPSource', name: 'SDARS_IP' }
};

module.exports = function (opt, x) {
  var log = x.log, someip = x.someip;
  var src = +(opt.src || 281);
  var d = DEFAULTS[src] || {};
  var owner = opt.owner || d.owner, name = opt.name || d.name;
  if (!owner || !name) throw new Error('--owner and --name for source ' + src);
  var uid = +(opt.uid || 4100), gid = +(opt.gid || 4150);
  if (process.getuid() === 0) { process.setgroups([gid]); process.setgid(gid); process.setuid(uid); }
  log('serve: source ' + src + ' ' + name + ', owner ' + owner + ', as ' + process.getuid() + ':' + process.getgid());

  var avail = [{ sourceID: src, availability: { availability: 'A_AVAILABLE', availabilityReason: 0 } }];
  var service;
  function ack(ev, payload) {
    // the reply goes out a moment later, as an owner would answer
    setTimeout(function () {
      service.fire(ev, payload).then(function () { log('serve: ' + ev + ' ' + JSON.stringify(payload)); },
        function (e) { log('serve: ' + ev + ' failed: ' + e); });
    }, 20);
  }
  var impl = {
    SourceAvailabilities: {
      getValue: function () { log('serve: SourceAvailabilities read'); return Promise.resolve(avail); },
      setValue: function (v) { return Promise.resolve(avail); }
    },
    asyncSetSourceState: function (p) {
      log('serve: asyncSetSourceState ' + JSON.stringify(p));
      ack('ackSetSourceState', { handle: p.handle, amError: 'E_OK' });
      return Promise.resolve({});
    },
    asyncSetSourceVolume: function (p) {
      log('serve: asyncSetSourceVolume ' + JSON.stringify(p));
      ack('ackSetSourceVolume', { handle: p.handle, volume: p.volume, amError: 'E_OK' });
      return Promise.resolve({});
    },
    asyncSetSourceSoundProperty: function (p) {
      log('serve: asyncSetSourceSoundProperty ' + JSON.stringify(p));
      ack('ackSetSourceSoundProperty', { handle: p.handle, amError: 'E_OK' });
      return Promise.resolve({});
    },
    asyncSetSourceSoundProperties: function (p) {
      log('serve: asyncSetSourceSoundProperties ' + JSON.stringify(p));
      ack('ackSetSourceSoundProperties', { handle: p.handle, amError: 'E_OK' });
      return Promise.resolve({});
    },
    asyncSetSourceNotificationConfiguration: function (p) {
      log('serve: asyncSetSourceNotificationConfiguration ' + JSON.stringify(p));
      ack('ackSourceNotificationConfiguration', { handle: p.handle, amError: 'E_OK' });
      return Promise.resolve({});
    },
    asyncAbort: function (p) { log('serve: asyncAbort ' + JSON.stringify(p)); return Promise.resolve({}); }
  };

  return someip.registerService(x.iface('AmSourceControl'), owner, impl)
    .then(function (s) { service = s; return s.init(); })
    .then(function () {
      log('serve: offering AmSourceControl ' + owner);
      return service.fire('SourceAvailabilities', avail).catch(function (e) { log('serve: fire availability: ' + e); });
    })
    .then(function () {
      if (opt['no-register']) return;
      return x.proxy('RoutingControlObserver', '1').then(function (obs) {
        return obs.callMethod('peekSource', { name: name }, 15000).then(function (r) {
          log('serve: peekSource ' + JSON.stringify(r));
          return obs.callMethod('registerSource', { sourceData: {
            sourceID: src, domainID: +(opt.domain || 2), name: name, sourceClassID: +(opt['class'] || 1),
            sourceState: 'SS_OFF', volume: 0, visible: true,
            available: { availability: 'A_AVAILABLE', availabilityReason: 0 }, interruptState: 'IS_OFF',
            listSoundProperties: [], listConnectionFormats: [+(opt.format || 1)], listMainSoundProperties: [],
            listMainNotificationConfigurations: [], listNotificationConfigurations: []
          } }, 15000);
        }).then(function (r) {
          log('serve: registerSource ' + JSON.stringify(r));
          return obs.callMethod('hookSourceAvailablityStatusChange',
            { sourceID: src, availability: { availability: 'A_AVAILABLE', availabilityReason: 0 } }, 15000)
            .then(function () { log('serve: marked available'); }, function (e) { log('serve: availability hook: ' + e); });
        });
      });
    })
    .then(function () {
      log('serve: ready; keep running (Ctrl-C ends the owner)');
      process.on('SIGTERM', function () { log('serve: stop'); process.exit(0); });
      return true; // keep the process
    });
};
