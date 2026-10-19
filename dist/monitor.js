export function severityOf(kind) {
    switch (kind) {
        case 'PON_CAIDA':
        case 'REINICIO_ROUTER':
        case 'WAN_CAIDA':
        case 'SESION':
        case 'SIN_DATOS':
            return 'alerta';
        case 'SALTO_RX':
        case 'RX_BAJO':
        case 'POSIBLE_REREGISTRO':
        case 'CONTADORES_A_CERO':
        case 'TEMP_ALTA':
            return 'aviso';
        default:
            return 'info';
    }
}
/** Clave de agrupación: tipo + mensaje sin números (así "OMCI +7 en 8s" y "OMCI +9 en 5s" cuentan como el mismo) */
export function dedupeKey(kind, msg) {
    return kind + '|' + msg.replace(/[-+]?\d+(?:[.,]\d+)?/g, '#');
}
/** Se agrupa con una entrada reciente (entre las últimas N y dentro de esta ventana) */
const DEDUPE_LOOKBACK = 12;
const DEDUPE_WINDOW_MS = 15 * 60_000;
export const DEFAULT_THRESHOLDS = { rxLow: -26, rxJump: 3, tempHigh: 70 };
const WRAP32 = 2 ** 32;
/** Huecos mayores que esto entre lecturas no cuentan para los tiempos (monitor parado, pausa...) */
export const MAX_CONTINUOUS_GAP_S = 60;
/** Delta de un contador de 32 bits que puede dar la vuelta */
export function counterDelta(prev, cur) {
    if (prev === null || cur === null)
        return null;
    return cur >= prev ? cur - prev : cur + WRAP32 - prev;
}
export const rxKey = (rx) => rx.toFixed(2);
export class Tracker {
    samples = [];
    events = [];
    maxSamples;
    th;
    rates = { downBps: null, upBps: null, downPps: null, upPps: null, omciPerMin: null };
    stats = { ponDrops: 0, rxJumps: 0, reboots: 0, reregs: 0, wanDrops: 0, errors: 0 };
    /** Tiempos acumulados (s) solo sobre tramos continuos */
    time = { total: 0, o5: 0, rxLow: 0, down: 0 };
    /** Tiempo (s) en cada nivel de RX (clave: dBm con 2 decimales) */
    rxLevels = new Map();
    rxMin = null;
    rxMax = null;
    dropStart = null;
    lowStart = null;
    rxIsLow = false;
    tempIsHigh = false;
    errStreak = 0;
    omciBase = null;
    /** Última RX válida (para detectar saltos que ocurren durante un corte) */
    lastRx = null;
    constructor(opts = {}) {
        this.maxSamples = opts.maxSamples ?? 3000;
        this.th = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
        this.onEvent = opts.onEvent ?? (() => { });
    }
    onEvent;
    get last() {
        return this.samples[this.samples.length - 1];
    }
    emit(kind, msg, t = Date.now()) {
        const e = { t, kind, sev: severityOf(kind), msg };
        this.onEvent(e); // el registro y los avisos reciben cada ocurrencia
        this.addDisplay(e);
        return e;
    }
    addDisplay(e) {
        const key = dedupeKey(e.kind, e.msg);
        const from = Math.max(0, this.events.length - DEDUPE_LOOKBACK);
        for (let i = this.events.length - 1; i >= from; i--) {
            const d = this.events[i];
            if (e.t - d.t > DEDUPE_WINDOW_MS)
                break;
            if (dedupeKey(d.kind, d.msg) === key) {
                this.events.splice(i, 1);
                this.events.push({ ...e, count: d.count + 1, first: d.first });
                return;
            }
        }
        this.events.push({ ...e, count: 1, first: e.t });
        if (this.events.length > 500)
            this.events.shift();
    }
    error(msg) {
        this.stats.errors++;
        this.errStreak++;
        this.emit('ERROR_LECTURA', msg);
        if (this.errStreak === 3)
            this.emit('SIN_DATOS', 'Tres lecturas seguidas fallidas: el router no responde');
    }
    /** Añade una muestra y devuelve los eventos que ha generado */
    push(s) {
        const prev = this.last;
        const ev = [];
        const add = (k, m) => ev.push(this.emit(k, m, s.t));
        if (this.errStreak >= 3)
            add('INFO', 'El router vuelve a responder');
        this.errStreak = 0;
        if (s.rx !== null) {
            this.rxMin = this.rxMin === null ? s.rx : Math.min(this.rxMin, s.rx);
            this.rxMax = this.rxMax === null ? s.rx : Math.max(this.rxMax, s.rx);
        }
        if (prev) {
            const dt = (s.t - prev.t) / 1000;
            // Tiempos: el intervalo se atribuye al estado de la lectura anterior
            if (dt > 0 && dt <= MAX_CONTINUOUS_GAP_S) {
                this.time.total += dt;
                if (prev.state === 'O5')
                    this.time.o5 += dt;
                else
                    this.time.down += dt;
                if (prev.rx !== null) {
                    const k = rxKey(prev.rx);
                    this.rxLevels.set(k, (this.rxLevels.get(k) ?? 0) + dt);
                    if (prev.rx < this.th.rxLow)
                        this.time.rxLow += dt;
                }
            }
            const rebooted = prev.uptime !== null && s.uptime !== null && s.uptime < prev.uptime;
            const reset = !rebooted && prev.pktsDown !== null && s.pktsDown !== null && s.pktsDown < prev.pktsDown && prev.pktsDown - s.pktsDown < WRAP32 / 2;
            // Estado de registro
            if (prev.state === 'O5' && s.state !== 'O5') {
                this.stats.ponDrops++;
                this.dropStart = s.t;
                const what = s.state === 'DESC' ? 'DESC (sin señal óptica)' : s.state;
                add('PON_CAIDA', `Registro perdido: O5 → ${what}${prev.rx !== null ? ` (RX previo ${prev.rx.toFixed(2)} dBm)` : ''}`);
            }
            else if (prev.state !== 'O5' && s.state === 'O5') {
                const dur = this.dropStart ? ` tras ${fmtDur((s.t - this.dropStart) / 1000)}` : '';
                this.dropStart = null;
                add('PON_RECUPERADA', `Registrada de nuevo (O5)${dur}`);
            }
            // Saltos de potencia (respecto a la última RX válida, para no perder los que ocurren durante un corte)
            const ref = this.lastRx;
            if (ref !== null && s.rx !== null && Math.abs(s.rx - ref) >= this.th.rxJump) {
                this.stats.rxJumps++;
                add('SALTO_RX', `RX ${ref.toFixed(2)} → ${s.rx.toFixed(2)} dBm (${s.rx > ref ? '+' : ''}${(s.rx - ref).toFixed(1)} dB)${prev.rx === null ? ' tras un corte' : ''}`);
            }
            if (rebooted) {
                this.stats.reboots++;
                add('REINICIO_ROUTER', `El router se ha reiniciado (uptime ${fmtDur(s.uptime ?? 0)})`);
                this.omciBase = null;
            }
            else if (reset) {
                add('CONTADORES_A_CERO', 'Contadores PON reiniciados');
                this.omciBase = null;
            }
            // Re-registro: ráfaga de OMCI muy por encima del ritmo normal
            // (si el contador baja es que se ha reiniciado: no es una ráfaga)
            const dOmci = prev.omciDown !== null && s.omciDown !== null && s.omciDown >= prev.omciDown ? s.omciDown - prev.omciDown : null;
            const partOfDrop = prev.state !== 'O5' || s.state !== 'O5'; // ya explicado por la caída/recuperación
            if (!rebooted && !reset && !partOfDrop && dOmci !== null && dOmci > 5 + dt / 60) {
                this.stats.reregs++;
                add('POSIBLE_REREGISTRO', `OMCI +${dOmci} en ${fmtDur(dt)}`);
            }
            // WAN
            const pw = prev.wan?.status, cw = s.wan?.status;
            if (pw && cw && pw !== cw) {
                if (cw === 'Connected')
                    add('WAN_OK', `WAN conectada (${s.wan?.ip || 'sin IP'})`);
                else {
                    this.stats.wanDrops++;
                    add('WAN_CAIDA', `WAN: ${pw} → ${cw}`);
                }
            }
            // Ritmos
            if (dt > 0 && !rebooted && !reset) {
                const bd = counterDelta(prev.bytesDown, s.bytesDown);
                const bu = counterDelta(prev.bytesUp, s.bytesUp);
                const pd = counterDelta(prev.pktsDown, s.pktsDown);
                const pu = counterDelta(prev.pktsUp, s.pktsUp);
                this.rates.downBps = bd === null ? null : (bd * 8) / dt;
                this.rates.upBps = bu === null ? null : (bu * 8) / dt;
                this.rates.downPps = pd === null ? null : pd / dt;
                this.rates.upPps = pu === null ? null : pu / dt;
            }
        }
        // Umbrales con histéresis (también en la primera lectura)
        if (s.rx !== null) {
            if (!this.rxIsLow && s.rx < this.th.rxLow) {
                this.rxIsLow = true;
                this.lowStart = s.t;
                add('RX_BAJO', `RX ${s.rx.toFixed(2)} dBm, por debajo de ${this.th.rxLow} dBm (margen ${(s.rx + 28).toFixed(1)} dB)`);
            }
            else if (this.rxIsLow && s.rx >= this.th.rxLow + 1) {
                this.rxIsLow = false;
                const dur = this.lowStart ? ` tras ${fmtDur((s.t - this.lowStart) / 1000)}` : '';
                add('RX_NORMAL', `RX ${s.rx.toFixed(2)} dBm, recuperada${dur}`);
            }
        }
        if (s.temp !== null) {
            if (!this.tempIsHigh && s.temp > this.th.tempHigh) {
                this.tempIsHigh = true;
                add('TEMP_ALTA', `Temperatura del transceptor ${s.temp.toFixed(1)} °C`);
            }
            else if (this.tempIsHigh && s.temp < this.th.tempHigh - 3)
                this.tempIsHigh = false;
        }
        if (s.omciDown !== null) {
            if (!this.omciBase)
                this.omciBase = { t: s.t, v: s.omciDown };
            const mins = (s.t - this.omciBase.t) / 60000;
            this.rates.omciPerMin = mins >= 1 ? (s.omciDown - this.omciBase.v) / mins : null;
        }
        if (s.rx !== null)
            this.lastRx = s.rx;
        this.samples.push(s);
        if (this.samples.length > this.maxSamples)
            this.samples.shift();
        return ev;
    }
    /** Niveles de RX ordenados por tiempo, con porcentaje */
    topLevels(n = 3) {
        const total = [...this.rxLevels.values()].reduce((a, b) => a + b, 0);
        if (!total)
            return [];
        return [...this.rxLevels].sort((a, b) => b[1] - a[1]).slice(0, n).map(([rx, t]) => ({ rx, pct: (t / total) * 100 }));
    }
}
export function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (d)
        return `${d}d ${h}h ${m}m`;
    if (h)
        return `${h}h ${m}m`;
    if (m)
        return `${m}m ${s}s`;
    return `${s}s`;
}
