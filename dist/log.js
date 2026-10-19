// Registro completo: JSONL (una línea por registro, un fichero por día) + log de eventos en texto
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const VOLATILE_WAN = /^X_TP_(Bytes|Packets|Uptime)/;
/** Fecha local AAAA-MM-DD */
export function localDate(t) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** ISO 8601 en hora local con desplazamiento, p. ej. 2026-10-20T12:03:11.123+02:00 */
export function isoLocal(t) {
    const d = new Date(t);
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${localDate(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
const hum = (t) => isoLocal(t).slice(0, 19).replace('T', ' ');
export class Recorder {
    opts;
    fd = null;
    fdPath = null;
    evFd = null;
    lastWan = null;
    now;
    enabled;
    eventsPath;
    constructor(opts) {
        this.opts = opts;
        this.now = opts.now ?? Date.now;
        this.enabled = !!(opts.file || opts.dir);
        if (opts.dir && !opts.file)
            mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
        this.eventsPath = opts.file ? opts.file.replace(/\.jsonl$/, '') + '.eventos.log' : opts.dir ? join(opts.dir, 'eventos.log') : null;
    }
    /** Ruta del JSONL actual (cambia a medianoche si se usa carpeta) */
    get path() {
        if (this.opts.file)
            return this.opts.file;
        if (this.opts.dir)
            return join(this.opts.dir, `pon-${localDate(this.now())}.jsonl`);
        return null;
    }
    write(rec) {
        const p = this.path;
        if (!p)
            return;
        if (p !== this.fdPath) {
            if (this.fd !== null)
                closeSync(this.fd);
            this.fd = openSync(p, 'a', 0o600); // solo legible por ti
            this.fdPath = p;
        }
        writeSync(this.fd, JSON.stringify(rec) + '\n');
    }
    text(line) {
        if (!this.eventsPath)
            return;
        if (this.evFd === null)
            this.evFd = openSync(this.eventsPath, 'a', 0o600);
        writeSync(this.evFd, line + '\n');
    }
    meta(info) {
        const t = this.now();
        this.write({ type: 'meta', t: isoLocal(t), ...info });
        this.text(`${hum(t)}  ─── inicio de monitorización ${info['host'] ? `(${info['host']})` : ''}`);
    }
    session(kind, msg) {
        const t = this.now();
        this.write({ type: 'session', t: isoLocal(t), kind, msg });
        this.text(`${hum(t)}  [sesión] ${msg}`);
    }
    event(e) {
        this.write({ type: 'event', t: isoLocal(e.t), kind: e.kind, sev: e.sev, msg: e.msg });
        const tag = e.sev === 'alerta' ? '[ALERTA]' : e.sev === 'aviso' ? '[aviso] ' : '[info]  ';
        this.text(`${hum(e.t)}  ${tag} ${e.kind.padEnd(18)} ${e.msg}`);
    }
    error(msg) {
        this.write({ type: 'error', t: isoLocal(this.now()), msg });
    }
    sample(s) {
        const r = (v, d = 2) => (v === null ? null : +v.toFixed(d));
        const rec = {
            type: 'sample', t: isoLocal(s.t),
            state: s.state, onuId: s.onuId, ponType: s.ponType,
            rx: r(s.rx), rxRaw: s.rxRaw, tx: r(s.tx), temp: r(s.temp), vcc: s.vcc, bias: r(s.bias),
            fecUs: s.fecUs, fecDs: s.fecDs,
            omciUp: s.omciUp, omciDown: s.omciDown, pktsUp: s.pktsUp, pktsDown: s.pktsDown, bytesUp: s.bytesUp, bytesDown: s.bytesDown,
            uptime: s.uptime, cpu: s.cpu, mem: r(s.mem, 1),
            wan: s.wan ? { name: s.wan.name, type: s.wan.type, status: s.wan.status, ip: s.wan.ip, gw: s.wan.gateway, uptime: s.wan.uptime ?? null } : null,
        };
        if (s.raw)
            rec['raw'] = { optc: s.raw.optc, stats: s.raw.stats, omci: s.raw.omci };
        this.write(rec);
        // La lista completa de conexiones WAN solo cuando cambia (es grande y casi siempre igual)
        if (s.raw?.wan) {
            // Se comparan sin los contadores de tráfico y uptime, que cambian en cada lectura
            const j = JSON.stringify(s.raw.wan.map(w => Object.fromEntries(Object.entries(w).filter(([k]) => !VOLATILE_WAN.test(k)))));
            if (j !== this.lastWan) {
                this.lastWan = j;
                this.write({ type: 'wan', t: isoLocal(s.t), raw: s.raw.wan });
            }
        }
    }
    close() {
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
            this.fdPath = null;
        }
        if (this.evFd !== null) {
            closeSync(this.evFd);
            this.evFd = null;
        }
    }
}
