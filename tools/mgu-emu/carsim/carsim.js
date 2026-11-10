// carsim: stand-ins for the car-side SOME/IP services the HMI waits for in
// the emulator (on the car they come from the IOC through ioclcproxy /
// SignalGateway, or from other ECUs). Served with the unit's own
// /usr/lib/someip.node, as root, from interface JSONs made from the unit's
// catalog (tools/someip_iface.py gen ...; README "Stand-in services").
//
//   node carsim.js [--pwf WOHNEN|FAHREN|PARKEN_BN_IO] [--lang ENGLISCH__UK]
//                  [--ctl /run/carsim/ctl] [--keys 'QEMU Virtio Keyboard'|none]
//
// Every field starts from its schema's default and is then set from CAR
// below; getters answer from that state, setters store and fire, notifiers
// are fired at start and every few seconds (no subscription callback in
// someip.node's stub API), vehicle condition with a running alive counter.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
var path = require('path');
var someip = require('/usr/lib/someip.node');

function arg(name, def) {
  var i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
var PWF = arg('pwf', 'WOHNEN');
var LANG = arg('lang', 'ENGLISCH__UK');
var KOM = { WOHNEN: 'KOM_WOHNEN', FAHREN: 'KOM_FAHREN', PARKEN_BN_IO: 'KOM_PARKEN_BN_IO' }[PWF] || 'KOM_WOHNEN';

// the car: what differs from each schema's defaults
var CAR = {
  Lifecycle: {
    instance: 'Front',
    fields: {
      powerStateDetailed: 'FULL_ON_USER_ON',
      powerStateDetailedExternal: { statusHeadunitInfotainmentFrontDetail: 'FULL_ON_USER_ON', statusHeadunit1: 0, statusHeadunit2: 0 },
      theatreMode: false,
      rseLowPowerMode: false,
      rseHmiMenu: false
    }
  },
  // the centre display (CID), on the car from the display controller: the HMI
  // drops CID touch while it thinks the monitor is off (CDevCarMonitor ->
  // CHmiDisplayService -> CHmiHomeTouchHandling)
  Monitor: {
    instance: 'Front',
    fields: {
      userMonitorControl: 'DISPLAY_ON',
      statusMonitorReady: 'MONITOR_READY',
      statusPicture: 'PICTURE_IS_VISIBLE',
      positionMonitor: 'FOLD_OUT'
    }
  },
  VehicleCondition: {
    instance: '1',
    fields: {
      VehicleCondition: {
        cRCConditionVehicle: 0, aliveConditionVehicle: 0, controlBasePartialNetworks: KOM,
        controlFunctionalPartialNetworks: 0, statusConditionVehicle: PWF,
        qualifierStatusConditionVehicle: 'SIGNALWERT_GUELTIG', dummy: 0
      },
      vehicleConditionNoCrc: null // filled from VehicleCondition below
    },
    alive: ['VehicleCondition', 'vehicleConditionNoCrc']
  },
  Key: { instance: '1', fields: {} },
  Vehicle: {
    instance: '1',
    fields: {
      statusNewCurrentUnitsStatusExt: {
        language: LANG, unitOfMeasurementTime: '_24_H', unitOfMeasurementTemperature: 'C',
        unitOfMeasurementSpeedometerDigital: 'KILOMETER', unitOfMeasurementConsumption: 'L_S_100KM',
        unitOfMeasurementFuel: 'LITER', unitOfMeasurementAirPressure: 'BAR',
        unitOfMeasurementDateExtended: 'REIHENFOLGE__TAG_P_MONAT_P_JAHR', unitOfMeasurementPowerSportMode: 'KW',
        unitOfMeasurementTorqueSportMode: 'NM', unitOfMeasurementConsumptionElectric: 'KWH__S__100KM'
      }
    }
  },
  // the iDrive controller (ZBE): fired on input only (FIFO, below), not cyclically
  FrontCCU: {
    instance: '1',
    quiet: true,
    fields: {
      statusRotaryEncoderState: {
        frontSequenceNumberOperatingElement: 0, frontRotaryEncoderOperation: 0,
        frontRotaryEncoderPushButton: 'KEINE_BETAETIGUNG', frontRotaryEncoderDeflection: 'MITTELSTELLUNG',
        frontOverflowRotaryController: 'KEIN_UEBERLAUF', frontAccelerationRegulationStatus: 'BESCHLEUNIGUNGSFUNKTION_AUS'
      },
      statusPushButtonsState: {
        frontOperationButton1: 'KEINE_BETAETIGUNG', frontOperationButton2: 'KEINE_BETAETIGUNG',
        frontOperationButton3: 'KEINE_BETAETIGUNG', frontOperationButton4: 'KEINE_BETAETIGUNG',
        frontOperationButton5: 'KEINE_BETAETIGUNG', frontOperationButton6: 'KEINE_BETAETIGUNG',
        frontOperationButton7: 'KEINE_BETAETIGUNG', frontOperationButton8: 'KEINE_BETAETIGUNG'
      }
    }
  }
};

// The controller, driven through a FIFO (one command per line):
//   rot N          turn N detents (negative: anticlockwise)
//   press          push the knob (short)
//   longpress      push the knob (long)
//   tilt N|E|S|W   push the knob sideways (short)
//   button 1..8    one of the buttons around the knob (short)
// e.g. echo press > /run/carsim/ctl
var CTL = arg('ctl', '/run/carsim/ctl');
var services = {};

function ccuFire(field, mutate, releaseMs) {
  var s = services.FrontCCU;
  if (!s) return;
  var st = s.state[field];
  if ('frontSequenceNumberOperatingElement' in st)
    st.frontSequenceNumberOperatingElement = (st.frontSequenceNumberOperatingElement + 1) % 255;
  var release = mutate(st);
  s.service.fire(field, st).catch(function (e) { console.error('carsim: ' + e); });
  if (release) setTimeout(function () {
    if ('frontSequenceNumberOperatingElement' in st)
      st.frontSequenceNumberOperatingElement = (st.frontSequenceNumberOperatingElement + 1) % 255;
    release(st);
    s.service.fire(field, st).catch(function (e) { console.error('carsim: ' + e); });
  }, releaseMs || 120);
}

function command(line) {
  var w = line.trim().split(/\s+/), c = w[0];
  if (!c) return;
  console.log('carsim: ctl ' + line.trim());
  var E = 'statusRotaryEncoderState', B = 'statusPushButtonsState';
  if (c === 'rot') {
    var n = parseInt(w[1] || '1', 10);
    ccuFire(E, function (st) { st.frontRotaryEncoderOperation = (st.frontRotaryEncoderOperation + n + 65535) % 65535; });
  } else if (c === 'press' || c === 'longpress') {
    var v = c === 'press' ? 'DREHGEBER_KURZ_GEDRUECKT' : 'DREHGEBER_LANG_GEDRUECKT';
    ccuFire(E, function (st) {
      st.frontRotaryEncoderPushButton = v;
      return function (st2) { st2.frontRotaryEncoderPushButton = 'KEINE_BETAETIGUNG'; };
    }, c === 'press' ? 150 : 1500);
  } else if (c === 'tilt') {
    var d = { N: 'NORD', E: 'OST', S: 'SUED', W: 'WEST' }[(w[1] || '').toUpperCase()];
    if (!d) return console.error('carsim: tilt N|E|S|W');
    ccuFire(E, function (st) {
      st.frontRotaryEncoderDeflection = d + '_KURZ_GEDRUECKT';
      return function (st2) { st2.frontRotaryEncoderDeflection = 'MITTELSTELLUNG'; };
    }, 150);
  } else if (c === 'button') {
    var k = 'frontOperationButton' + parseInt(w[1], 10);
    ccuFire(B, function (st) {
      if (!(k in st)) return;
      st[k] = 'TASTE_KURZ_GEDRUECKT';
      return function (st2) { st2[k] = 'KEINE_BETAETIGUNG'; };
    }, 150);
  } else if (c === 'set') {
    // set SERVICE FIELD JSON: change a stand-in's field and fire it (e.g. a
    // power state change: the audio manager starts MediaSink_Front on one)
    var s = services[w[1]], f = w[2], val;
    try { val = JSON.parse(w.slice(3).join(' ')); } catch (e) { return console.error('carsim: set SERVICE FIELD JSON'); }
    if (!s || !(f in s.state)) return console.error('carsim: no field ' + w[1] + '.' + f);
    s.state[f] = val;
    s.service.fire(f, val).catch(function (e) { console.error('carsim: fire ' + f + ': ' + e); });
  } else console.error('carsim: unknown command ' + c);
}

function listen() {
  var fs = require('fs'), cp = require('child_process');
  try { fs.unlinkSync(CTL); } catch (e) { /* none yet */ }
  cp.execFileSync('mkfifo', ['-m', '0660', CTL]);
  (function open() {
    // each writer's lines, then EOF: reopen for the next one
    var buf = '';
    fs.createReadStream(CTL, { encoding: 'utf8' })
      .on('data', function (d) { buf += d; var l = buf.split('\n'); buf = l.pop(); l.forEach(command); })
      .on('end', function () { if (buf) command(buf); open(); })
      .on('error', function (e) { console.error('carsim: ctl ' + e); setTimeout(open, 1000); });
  })();
  console.log('carsim: controller on ' + CTL);
}

// The controller on the window's keyboard: QEMU's virtio keyboard is read
// as is (no grab: nothing else in the VM reads it; Winston reads only
// tap2touch). Left / Right turn (held: repeats), Enter pushes (held 0.8 s or
// more: long), Up / Down tilt north / south, Shift+Left / Right tilt west /
// east, Backspace / Esc are BACK (button 2), F1..F8 the buttons 1..8.
// --keys NAME reads another device by its name, --keys none none.
var KEYS = arg('keys', 'QEMU Virtio Keyboard');
var KEY = { ESC: 1, BACKSPACE: 14, ENTER: 28, LEFTSHIFT: 42, RIGHTSHIFT: 54, F1: 59, F8: 66,
  KPENTER: 96, UP: 103, LEFT: 105, RIGHT: 106, DOWN: 108 };
var BACK_BUTTON = 2; // the HMI walks back through its screens on it (keycode 2)

function keyEvent(code, value, st) {
  // value: 1 down, 2 auto-repeat, 0 up
  if (code === KEY.LEFTSHIFT || code === KEY.RIGHTSHIFT) { st.shift = value !== 0; return; }
  if (code === KEY.LEFT || code === KEY.RIGHT) {
    if (value === 0) return;
    if (st.shift) { if (value === 1) command('tilt ' + (code === KEY.LEFT ? 'W' : 'E')); }
    else command('rot ' + (code === KEY.LEFT ? -1 : 1));
  } else if (code === KEY.ENTER || code === KEY.KPENTER) {
    if (value === 1) st.enterAt = Date.now();
    else if (value === 0 && st.enterAt) {
      command(Date.now() - st.enterAt >= 800 ? 'longpress' : 'press');
      st.enterAt = 0;
    }
  } else if (value !== 1) {
    return;
  } else if (code === KEY.UP || code === KEY.DOWN) {
    command('tilt ' + (code === KEY.UP ? 'N' : 'S'));
  } else if (code === KEY.BACKSPACE || code === KEY.ESC) {
    command('button ' + BACK_BUTTON);
  } else if (code >= KEY.F1 && code <= KEY.F8) {
    command('button ' + (code - KEY.F1 + 1));
  }
}

function readKeys() {
  if (KEYS === 'none') return;
  var fs = require('fs');
  function device() {
    var found = null;
    fs.readFileSync('/proc/bus/input/devices', 'utf8').split('\n\n').forEach(function (b) {
      var ev = /Handlers=.*\b(event\d+)/.exec(b);
      if (!found && ev && b.indexOf('N: Name="' + KEYS + '"') >= 0) found = '/dev/input/' + ev[1];
    });
    return found;
  }
  (function open() {
    var dev = null;
    try { dev = device(); } catch (e) { console.error('carsim: keys: ' + e); }
    if (!dev) return console.error('carsim: keys: no input device named ' + KEYS);
    var st = { shift: false, enterAt: 0 }, rest = Buffer.alloc(0);
    // struct input_event on x86_64: timeval (16), type, code (u16), value (s32)
    fs.createReadStream(dev)
      .on('data', function (d) {
        var b = Buffer.concat([rest, d]), o = 0;
        for (; o + 24 <= b.length; o += 24)
          if (b.readUInt16LE(o + 16) === 1) keyEvent(b.readUInt16LE(o + 18), b.readInt32LE(o + 20), st);
        rest = b.slice(o);
      })
      .on('error', function (e) { console.error('carsim: keys: ' + e); setTimeout(open, 2000); });
    console.log('carsim: controller on the keys of ' + dev + ' (' + KEYS + ')');
  })();
}

// a value for a schema: its declared default ("d") where it has one, else zero / first
function defaultOf(s) {
  if (!s || !s.t) return undefined;
  switch (s.t) {
    case 'Struct': {
      var o = {};
      (s.e || []).forEach(function (m) { o[m.n] = defaultOf(m); });
      return o;
    }
    case 'Enum': {
      var names = Object.keys(s.e || {});
      if (s.d !== undefined) for (var i = 0; i < names.length; i++) if (s.e[names[i]] === s.d) return names[i];
      return names[0];
    }
    case 'Array': return [];
    case 'Boolean': return false;
    case 'Utf8': case 'Utf8D': case 'Utf16': case 'Utf16D': return '';
    case 'ByteBuffer': return [];
    case 'Float': case 'Double': return 0;
    default: return 0; // integers; "d" there is the invalid value, not a default
  }
}

function merge(base, over) {
  if (over === null || over === undefined) return base;
  if (typeof over !== 'object' || Array.isArray(over) || typeof base !== 'object' || base === null) return over;
  Object.keys(over).forEach(function (k) { base[k] = merge(base[k], over[k]); });
  return base;
}

function start(name) {
  var cfg = require(path.join(__dirname, name + '.json'));
  var car = CAR[name];
  var state = {};
  var service;
  Object.keys(cfg.fields || {}).forEach(function (f) {
    state[f] = merge(defaultOf(cfg.fields[f].schema), car.fields[f]);
  });
  if (name === 'VehicleCondition') // the same signals, fewer members (no CRC / alive)
    Object.keys(state.vehicleConditionNoCrc).forEach(function (k) {
      if (k in state.VehicleCondition) state.vehicleConditionNoCrc[k] = state.VehicleCondition[k];
    });

  var impl = {};
  Object.keys(cfg.methods || {}).forEach(function (m) {
    impl[m] = function (params) {
      console.log('carsim: ' + name + '.' + m + '(' + JSON.stringify(params) + ')');
      return Promise.resolve(defaultOf(cfg.methods[m].retSchema) || {});
    };
  });
  Object.keys(cfg.fields || {}).forEach(function (f) {
    impl[f] = {
      getValue: function () { return Promise.resolve(state[f]); },
      setValue: function (v) {
        console.log('carsim: ' + name + '.' + f + ' := ' + JSON.stringify(v));
        state[f] = v;
        if (cfg.fields[f].event && service) service.fire(f, v).catch(function () {});
        return Promise.resolve(v);
      }
    };
  });

  function fireAll() {
    if (car.alive) car.alive.forEach(function (f) {
      if (state[f] && 'aliveConditionVehicle' in state[f]) state[f].aliveConditionVehicle = (state[f].aliveConditionVehicle + 1) % 15;
    });
    return Promise.all(Object.keys(cfg.fields || {}).filter(function (f) { return cfg.fields[f].event; })
      .map(function (f) { return service.fire(f, state[f]).catch(function (e) { console.error('carsim: fire ' + name + '.' + f + ': ' + e); }); }));
  }

  return someip.registerService(cfg, car.instance, impl)
    .then(function (s) { service = s; services[name] = { service: s, state: state }; return s.init(); })
    .then(function () {
      console.log('carsim: offering ' + cfg.name + ' (0x' + cfg.serviceId.toString(16) + ', ' + car.instance + ')');
      return fireAll();
    })
    .then(function () { if (!car.quiet) setInterval(fireAll, name === 'VehicleCondition' ? 1000 : 3000); });
}

setImmediate(function () {
  console.log('carsim: PWF ' + PWF + ', language ' + LANG);
  Object.keys(CAR).reduce(function (p, n) {
    return p.then(function () { return start(n); }).catch(function (e) { console.error('carsim: ' + n + ': ' + (e && e.stack || e)); });
  }, Promise.resolve()).then(listen).then(readKeys).then(watchLanguage);
});

// The HMI takes its display language from the car only when it is set in the
// HMI (HMIControl.selectLanguage -> Vehicle.newCurrentUnitsConfigExt, above).
// A fresh disk has none (no text on screen): set LANG whenever the HMI says
// it has no language. The choice persists in /var/opt/public/hmi.
function watchLanguage() {
  var ctx, ctl;
  function proxy(file) {
    return someip.buildProxy(require(path.join(__dirname, file)), 'HMI_CID')
      .then(function (p) { return p.init().then(function () { return p.subscribeToAvailability(function () {}); }).then(function () { return p; }); });
  }
  function check() {
    ctx.getValue('currentDisplayLanguage', 15000)
      .then(function (l) {
        if (l !== 'KEINE_SPRACHE') return;
        console.log('carsim: HMI has no display language, selecting ' + LANG);
        return ctl.callMethod('selectLanguage', { initiator: 'HMI_HU', language: LANG }, 15000);
      })
      .catch(function () { /* HMI not up yet */ });
  }
  Promise.all([proxy('HMIContext.json'), proxy('HMIControl.json')])
    .then(function (p) { ctx = p[0]; ctl = p[1]; check(); setInterval(check, 15000); })
    .catch(function (e) { console.error('carsim: language watch: ' + e); });
}
