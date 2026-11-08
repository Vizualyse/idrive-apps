// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * mqtt_bus: the tools' shared bus. The broker is native/vizualyse-bus
 * (Mosquitto, on a Unix socket in a folder only root can enter:
 * /run/vizualyse-bus/mqtt.sock); this is a minimal MQTT 3.1.1 client of our
 * own for Node 8, with no dependencies: QoS 0, retained messages, a last
 * will, keep-alive, reconnection.
 *
 * On it, asks: a tool asks the others to switch something off (or on) while
 * it needs that, as one retained message on vz/ask/<its id>:
 *
 *   {"ask":{"cluster-video":"off","hud-video":"off"},"why":"a game is running","at":"..."}
 *
 * replaced by its next ask, cleared by an empty message: by ask(null), by
 * close(), and by the broker (its last will) when the tool dies or its
 * connection goes. Every tool subscribes to vz/ask/+ and keeps the live asks
 * of the others. So it is level-triggered: a tool that starts or reconnects
 * late gets every live ask at once (they are retained), and a tool that goes
 * takes its asks with it. Without the bus (not installed, not up) nobody asks
 * anything: each tool works as it would alone; asks are kept and sent once
 * the bus is there.
 *
 *   const { Bus } = require('./mqtt_bus.js');
 *   const bus = new Bus('vizualyse-steam', { log });
 *   bus.ask({ 'cluster-video': 'off' }, 'a game is running');
 *   bus.ask(null);
 *   bus.on('asks', () => { const a = bus.asked('cluster-video', 'off'); ... });   // [{ from, why, at }]
 *   bus.close();
 *
 * Names in use (platform/BUILDING-APPS.md, "The bus"): cluster-video and
 * hud-video, a tool's video on the instrument cluster or the HUD (its
 * decoding, and cluster-render's upload); steam and browser, the tool itself
 * (a game, Chromium).
 *
 * at is when the ask was made (kept when it is sent again after a
 * reconnection): a tool that the user starts while another asks it off can
 * yield only to asks made after its own start, so the newer start wins.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.VZ_BUS_SOCKET || '/run/vizualyse-bus/mqtt.sock';
const PREFIX = 'vz/ask/';
const KEEPALIVE = 30;          /* s: a ping every half of it; nothing heard for 1.5x: gone */
const RETRY_MS = 5000;

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, SUBSCRIBE = 8, SUBACK = 9, PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;

function str(s) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8');
    const l = Buffer.alloc(2);
    l.writeUInt16BE(b.length, 0);
    return Buffer.concat([l, b]);
}

/* A packet: its type and flags, the remaining length (7 bits a byte), the rest. */
function packet(type, flags, body) {
    const len = [];
    let n = body.length;
    do {
        let d = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) d |= 128;
        len.push(d);
    } while (n > 0);
    return Buffer.concat([Buffer.from([(type << 4) | flags].concat(len)), body]);
}

class Bus extends EventEmitter {
    /* id: the tool's id (the MQTT client id, and its ask topic). o: { log,
     * socket (VZ_BUS_SOCKET or the broker's) }. Connects at once, and again
     * every 5 s while the bus isn't there. */
    constructor(id, o) {
        super();
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('mqtt_bus: a tool id, not ' + JSON.stringify(id));
        o = o || {};
        this.id = id;
        this.socket = o.socket || SOCKET;
        this._log = o.log || (() => {});
        this.connected = false;
        this.mine = null;           /* our ask: { ask, why, at }, or null */
        this.others = {};           /* id -> { ask, why, at } */
        this._sock = null;
        this._rx = Buffer.alloc(0);
        this._timer = null;
        this._ping = null;
        this._heard = 0;
        this._closed = false;
        this._said = null;          /* the last state logged: say each change once */
        this._connect();
    }

    _say(state, line) {
        if (this._said === state) return;
        this._said = state;
        this._log('bus: ' + line);
    }

    _connect() {
        this._timer = null;
        if (this._closed) return;
        const s = net.connect(this.socket);
        this._sock = s;
        this._rx = Buffer.alloc(0);
        s.on('connect', () => {
            /* clean session; will: an empty retained ask, so the broker clears
             * ours when we go without saying so */
            const topic = PREFIX + this.id;
            const flags = 0x02 | 0x04 | 0x20;
            const ka = Buffer.alloc(2);
            ka.writeUInt16BE(KEEPALIVE, 0);
            s.write(packet(CONNECT, 0, Buffer.concat([str('MQTT'), Buffer.from([4, flags]), ka, str(this.id), str(topic), str('')])));
        });
        s.on('data', (d) => {
            this._heard = Date.now();
            this._rx = Buffer.concat([this._rx, d]);
            try { this._parse(); } catch (e) { this._say('bad', 'a bad packet from the broker (' + e.message + ')'); s.destroy(); }
        });
        s.on('error', (e) => {
            this._say('away:' + e.code, 'not there (' + (e.code || e.message) + '): working alone, trying every ' + RETRY_MS / 1000 + ' s');
        });
        s.on('close', () => {
            if (this._sock !== s) return;
            this._sock = null;
            clearInterval(this._ping); this._ping = null;
            const had = this.connected || Object.keys(this.others).length;
            if (this.connected) this._say('lost', 'connection lost: working alone until it is back');
            this.connected = false;
            /* nobody's asks hold without the bus: they come again, retained, at the next connection */
            this.others = {};
            if (had) this.emit('asks');
            if (!this._closed) this._timer = setTimeout(() => this._connect(), RETRY_MS);
        });
    }

    _parse() {
        for (;;) {
            if (this._rx.length < 2) return;
            let len = 0, mul = 1, i = 1, b;
            do {
                if (i >= this._rx.length) return;
                if (i > 4) throw new Error('remaining length');
                b = this._rx[i++];
                len += (b & 127) * mul;
                mul *= 128;
            } while (b & 128);
            if (this._rx.length < i + len) return;
            const type = this._rx[0] >> 4, flags = this._rx[0] & 15, body = this._rx.slice(i, i + len);
            this._rx = this._rx.slice(i + len);
            this._packet(type, flags, body);
        }
    }

    _packet(type, flags, body) {
        if (type === CONNACK) {
            if (body[1] !== 0) throw new Error('refused (' + body[1] + ')');
            this.connected = true;
            this._say('up', 'connected (' + this.socket + ')');
            this._heard = Date.now();
            this._ping = setInterval(() => {
                if (Date.now() - this._heard > KEEPALIVE * 1500) { if (this._sock) this._sock.destroy(); return; }
                this._write(packet(PINGREQ, 0, Buffer.alloc(0)));
            }, KEEPALIVE * 500);
            this._write(packet(SUBSCRIBE, 2, Buffer.concat([Buffer.from([0, 1]), str(PREFIX + '+'), Buffer.from([0])])));
            if (this.mine) this._publishMine();
            this.emit('connected');
        } else if (type === PUBLISH) {
            const tl = body.readUInt16BE(0), topic = body.slice(2, 2 + tl).toString('utf8');
            const qos = (flags >> 1) & 3;
            const payload = body.slice(2 + tl + (qos ? 2 : 0));
            if (topic.indexOf(PREFIX) !== 0) return;
            const from = topic.slice(PREFIX.length);
            if (from === this.id || !from) return;
            let m = null;
            if (payload.length) {
                try { m = JSON.parse(payload.toString('utf8')); } catch (e) { m = null; }
                if (!m || typeof m.ask !== 'object' || !m.ask) m = null;
            }
            const before = JSON.stringify(this.others[from] || null);
            if (m) this.others[from] = { ask: m.ask, why: String(m.why || ''), at: m.at || null };
            else delete this.others[from];
            if (JSON.stringify(this.others[from] || null) !== before) {
                this._log('bus: ' + from + (m ? ' asks ' + JSON.stringify(m.ask) + (m.why ? ' (' + m.why + ')' : '') : ' asks nothing now'));
                this.emit('asks');
            }
        }
        /* SUBACK, PINGRESP: nothing to do (heard) */
    }

    _write(b) {
        if (!this._sock || !this.connected) return false;
        try { this._sock.write(b); return true; } catch (e) { return false; }
    }

    _publishMine() {
        const body = this.mine ? JSON.stringify(this.mine) : '';
        this._write(packet(PUBLISH, 1 /* retain */, Buffer.concat([str(PREFIX + this.id), Buffer.from(body, 'utf8')])));
    }

    /* Our ask: { name: 'off' | 'on', ... } and why (shown to people), or
     * null for none. Kept: sent again after every reconnection. */
    ask(what, why) {
        const keys = what ? Object.keys(what) : [];
        const next = keys.length ? { ask: Object.assign({}, what), why: String(why || ''), at: new Date().toISOString() } : null;
        if (JSON.stringify(next && next.ask) === JSON.stringify(this.mine && this.mine.ask) && (next ? next.why : '') === (this.mine ? this.mine.why : '')) return;
        this.mine = next;
        this._log('bus: we ask ' + (next ? JSON.stringify(next.ask) + (next.why ? ' (' + next.why + ')' : '') : 'nothing now') + (this.connected ? '' : ' (sent once the bus is there)'));
        this._publishMine();
    }

    /* Who asks that name be value now: [{ from, why }] (others only). */
    asked(name, value) {
        return Object.keys(this.others).sort().filter((k) => this.others[k].ask[name] === value)
            .map((k) => ({ from: k, why: this.others[k].why, at: this.others[k].at }));
    }

    /* For a status: connected, our ask, the others'. */
    state() {
        return { connected: this.connected, mine: this.mine ? this.mine.ask : null, others: Object.keys(this.others).sort().map((k) => ({ from: k, ask: this.others[k].ask, why: this.others[k].why })) };
    }

    /* Our ask cleared, then gone (a stop of the tool). */
    close() {
        this._closed = true;
        clearTimeout(this._timer); this._timer = null;
        clearInterval(this._ping); this._ping = null;
        if (this._sock) {
            if (this.connected && this.mine) { this.mine = null; this._publishMine(); }
            this._write(packet(DISCONNECT, 0, Buffer.alloc(0)));
            try { this._sock.end(); } catch (e) { /* gone */ }
        }
    }
}

module.exports = { Bus, SOCKET, PREFIX };
