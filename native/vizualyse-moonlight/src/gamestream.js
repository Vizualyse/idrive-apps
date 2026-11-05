// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The GameStream HTTP side of a Moonlight client, as Sunshine (and NVIDIA's
 * GameStream) speak it: serverinfo, PIN pairing, the app list, launch /
 * resume and quit. The protocol follows moonlight-embedded's
 * libgamestream/client.c (GPL-3.0-or-later) and moonlight-qt's pairing
 * checks. Node 8 (the head unit's): crypto and https only.
 *
 * The client's identity is a certificate and key (moonlight-core gencert)
 * and a unique id; a paired host's certificate is kept and pinned on every
 * HTTPS request after pairing.
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const HTTP_PORT = 47989;
const HTTPS_PORT = 47984;
const DEVICE_NAME = 'iDrive';

/* ---- XML ------------------------------------------------------------------ */

function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

/* The text of the first <tag>, or null. */
function tag(xml, name) {
    const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml);
    return m ? unescapeXml(m[1].trim()) : null;
}

/* The root's status: throws a host error for anything but 200. */
function checkStatus(xml) {
    const m = /<root[^>]*\sstatus_code="(-?\d+)"/.exec(xml);
    if (!m) throw new Error('not a GameStream reply');
    if (m[1] !== '200') {
        const msg = /status_message="([^"]*)"/.exec(xml);
        const e = new Error('host: ' + (msg ? unescapeXml(msg[1]) : 'status ' + m[1]));
        e.status = Number(m[1]);
        throw e;
    }
    return xml;
}

function apps(xml) {
    const out = [];
    const re = /<App>([\s\S]*?)<\/App>/g;
    let m;
    while ((m = re.exec(xml))) {
        const id = Number(tag(m[1], 'ID'));
        if (id) out.push({ id: id, name: tag(m[1], 'AppTitle') || 'App ' + id, hdr: tag(m[1], 'IsHdrSupported') === '1' });
    }
    return out;
}

/* ---- certificates --------------------------------------------------------- */

function pemToDer(pem) {
    const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
}

/* DER: the header of the element at `off`: { tag, start, len, end }. */
function der(buf, off) {
    const t = buf[off];
    let len = buf[off + 1], p = off + 2;
    if (len & 0x80) {
        const n = len & 0x7f;
        if (n < 1 || n > 4) throw new Error('bad DER length');
        len = 0;
        for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
    }
    if (p + len > buf.length) throw new Error('truncated DER');
    return { tag: t, start: p, len: len, end: p + len };
}

/* The signature bytes of an X.509 certificate (PEM): Certificate ::=
 * SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }. */
function certSignature(pem) {
    const d = pemToDer(pem);
    const cert = der(d, 0);
    if (cert.tag !== 0x30) throw new Error('not a certificate');
    const tbs = der(d, cert.start);
    const alg = der(d, tbs.end);
    const sig = der(d, alg.end);
    if (sig.tag !== 0x03) throw new Error('no signature in the certificate');
    return d.slice(sig.start + 1, sig.end);   /* past the unused-bits byte */
}

/* ---- the client ------------------------------------------------------------ */

function hex(b) { return Buffer.from(b).toString('hex'); }
function uuid() {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
function aes(key, data, decrypt) {
    const c = decrypt ? crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0)) : crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
}

class GameStream {
    /* id: { uniqueId, cert (PEM), key (PEM) }; host: { address, httpPort?,
     * httpsPort?, serverCert? (PEM, once paired) } */
    constructor(id, host, opts) {
        this.id = id;
        this.host = Object.assign({ httpPort: HTTP_PORT, httpsPort: HTTPS_PORT }, host);
        this.timeout = (opts && opts.timeout) || 8000;
        this.log = (opts && opts.log) || (() => {});
    }

    _url(path, params) {
        const q = Object.assign({ uniqueid: this.id.uniqueId, uuid: uuid() }, params || {});
        return path + '?' + Object.keys(q).map((k) => k + '=' + encodeURIComponent(q[k])).join('&');
    }

    /* GET over HTTP or HTTPS (with the client certificate, the host's pinned
     * once paired): the body. timeout in ms (pairing waits for the PIN). */
    _get(secure, path, params, timeout) {
        const h = this.host;
        const opts = { host: h.address, port: secure ? h.httpsPort : h.httpPort, path: this._url(path, params), method: 'GET',
            headers: { Connection: 'close' } };
        /* agent: false: no TLS session reuse; Sunshine answers a resumed session
         * with an internal-error alert (seen with Node 8's OpenSSL 1.0.2) */
        if (secure) Object.assign(opts, { key: this.id.key, cert: this.id.cert, rejectUnauthorized: false, agent: false });
        const t = timeout || this.timeout;
        return new Promise((resolve, reject) => {
            const req = (secure ? https : http).request(opts, (res) => {
                if (secure && h.serverCert) {
                    const peer = res.socket.getPeerCertificate && res.socket.getPeerCertificate();
                    if (!peer || !peer.raw || !peer.raw.equals(pemToDer(h.serverCert))) {
                        req.abort();
                        return reject(new Error('the host\'s certificate changed since pairing: pair again'));
                    }
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (d) => { body += d; if (body.length > 4 << 20) req.abort(); });
                res.on('end', () => (res.statusCode === 200 || /<root/.test(body) ? resolve(body) : reject(new Error('HTTP ' + res.statusCode))));
            });
            req.setTimeout(t, () => { req.abort(); reject(new Error('no answer from ' + h.address + ' in ' + Math.round(t / 1000) + ' s')); });
            req.on('error', (e) => reject(new Error(h.address + ': ' + e.message)));
            req.end();
        });
    }

    /* serverinfo over HTTPS when paired (only that tells whether this client
     * is paired), else over HTTP. */
    serverInfo() {
        const parse = (xml, secure) => {
            checkStatus(xml);
            const appversion = tag(xml, 'appversion') || '';
            const info = {
                name: tag(xml, 'hostname') || this.host.address,
                uniqueId: tag(xml, 'uniqueid'),
                appversion: appversion,
                gfeversion: tag(xml, 'GfeVersion') || '',
                major: parseInt(appversion, 10) || 0,
                httpsPort: Number(tag(xml, 'HttpsPort')) || HTTPS_PORT,
                paired: tag(xml, 'PairStatus') === '1',
                currentGame: Number(tag(xml, 'currentgame')) || 0,
                state: tag(xml, 'state') || '',
                codecs: Number(tag(xml, 'ServerCodecModeSupport')) || 1,
                mac: tag(xml, 'mac'),
                secure: secure,
            };
            /* after GFE 2.8 currentgame stays set after a stream: only busy counts */
            if (info.state.indexOf('_SERVER_BUSY') < 0) info.currentGame = 0;
            this.host.httpsPort = info.httpsPort;
            return info;
        };
        const plain = () => this._get(false, '/serverinfo').then((x) => parse(x, false));
        if (!this.host.serverCert) return plain();
        return this._get(true, '/serverinfo').then((x) => parse(x, true), (e) => {
            if (/certificate changed/.test(e.message)) throw e;
            return plain().then((i) => Object.assign(i, { paired: false }));
        });
    }

    /* Pair with the PIN the user types on the host (Sunshine's web page, PIN
     * tab). Resolves with the host's certificate (PEM); the first step waits
     * up to `wait` ms for the PIN. */
    pair(pin, wait) {
        if (!/^\d{4}$/.test(pin)) return Promise.reject(new Error('the PIN is 4 digits'));
        const salt = crypto.randomBytes(16);
        const ask = (params, secure, t) => this._get(!!secure, '/pair', Object.assign({ devicename: DEVICE_NAME, updateState: 1 }, params), t)
            .then(checkStatus).then((x) => {
                if (tag(x, 'paired') !== '1') throw new Error('the host refused the pairing');
                return x;
            });
        let info, key, serverCert, challenge, serverResponse, serverChallenge, clientSecret;
        const unpair = (e) => this._get(false, '/unpair').catch(() => null).then(() => { throw e; });
        return this.serverInfo().then((i) => {
            info = i;
            if (info.paired) return Promise.reject(new Error('already paired'));
            const hash = info.major >= 7 ? 'sha256' : 'sha1';
            const H = (b) => crypto.createHash(hash).update(b).digest();
            key = H(Buffer.concat([salt, Buffer.from(pin, 'ascii')])).slice(0, 16);
            this.log('pair: getservercert (waiting for the PIN on the host)');
            return ask({ phrase: 'getservercert', salt: hex(salt), clientcert: hex(Buffer.from(this.id.cert, 'ascii')) }, false, wait || 120000)
                .then((x) => {
                    const plain = tag(x, 'plaincert');
                    if (!plain) throw new Error('the host sent no certificate (is another pairing in progress?)');
                    serverCert = Buffer.from(plain, 'hex').toString('ascii');
                    challenge = crypto.randomBytes(16);
                    this.log('pair: clientchallenge');
                    return ask({ clientchallenge: hex(aes(key, challenge)) });
                })
                .then((x) => {
                    const enc = Buffer.from(tag(x, 'challengeresponse') || '', 'hex');
                    const hl = hash === 'sha256' ? 32 : 20;
                    if (enc.length < hl + 16 || enc.length % 16) throw new Error('bad challenge response');
                    const dec = aes(key, enc, true);
                    serverResponse = dec.slice(0, hl);
                    serverChallenge = dec.slice(hl, hl + 16);
                    clientSecret = crypto.randomBytes(16);
                    const resp = H(Buffer.concat([serverChallenge, certSignature(this.id.cert), clientSecret]));
                    const padded = Buffer.alloc(32);
                    resp.copy(padded);
                    this.log('pair: serverchallengeresp');
                    return ask({ serverchallengeresp: hex(aes(key, padded)) });
                })
                .then((x) => {
                    const secret = Buffer.from(tag(x, 'pairingsecret') || '', 'hex');
                    if (secret.length <= 16) throw new Error('bad pairing secret');
                    const serverSecret = secret.slice(0, 16), sig = secret.slice(16);
                    if (!crypto.createVerify('RSA-SHA256').update(serverSecret).verify(serverCert, sig)) {
                        throw new Error('the host\'s pairing secret is not signed by its certificate (MITM?)');
                    }
                    const expect = H(Buffer.concat([challenge, certSignature(serverCert), serverSecret]));
                    if (!expect.equals(serverResponse)) throw new Error('wrong PIN');
                    const signed = crypto.createSign('RSA-SHA256').update(clientSecret).sign(this.id.key);
                    this.log('pair: clientpairingsecret');
                    return ask({ clientpairingsecret: hex(Buffer.concat([clientSecret, signed])) });
                })
                .then(() => {
                    this.log('pair: pairchallenge (HTTPS)');
                    return ask({ phrase: 'pairchallenge' }, true);
                })
                .then(() => {
                    this.host.serverCert = serverCert;
                    return serverCert;
                })
                .catch(unpair);
        });
    }

    appList() {
        return this._get(true, '/applist').then(checkStatus).then(apps);
    }

    /* Launch appId (or resume it when it is running): { rtsp, rikey, rikeyid }
     * for moonlight-core stream. cfg: { width, height, fps, sops, localAudio,
     * gamepadMask, resume } */
    launch(appId, cfg) {
        const rikey = crypto.randomBytes(16), iv = crypto.randomBytes(4);
        const rikeyid = iv.readInt32BE(0);
        const params = {
            appid: appId, mode: cfg.width + 'x' + cfg.height + 'x' + cfg.fps, additionalStates: 1,
            sops: cfg.sops ? 1 : 0, rikey: hex(rikey), rikeyid: rikeyid, localAudioPlayMode: cfg.localAudio ? 1 : 0,
            surroundAudioInfo: 196610, /* stereo: channel mask 0x3 << 16 | 2 channels */
            remoteControllersBitmap: cfg.gamepadMask || 1, gcmap: cfg.gamepadMask || 1,
            corever: 1,   /* moonlight-common-c's LiGetLaunchUrlQueryParameters() */
        };
        return this._get(true, cfg.resume ? '/resume' : '/launch', params, 30000).then(checkStatus).then((x) => {
            const ok = tag(x, 'gamesession') || tag(x, 'resume');
            if (!ok || ok === '0') throw new Error('the host did not start the game');
            return { rtsp: tag(x, 'sessionUrl0'), rikey: hex(rikey), rikeyid: rikeyid };
        });
    }

    quit() {
        return this._get(true, '/cancel', null, 15000).then(checkStatus).then((x) => {
            if (tag(x, 'cancel') === '0') throw new Error('the host did not close the game');
        });
    }
}

module.exports = { GameStream, certSignature, pemToDer, tag, apps, checkStatus, HTTP_PORT, HTTPS_PORT };
