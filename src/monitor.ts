// Lógica de seguimiento: deltas, ritmos, tiempos y detección de eventos entre muestras
import type { PonSample } from './pon.js';

export type EventKind =
  | 'PON_CAIDA'
  | 'PON_RECUPERADA'
  | 'SALTO_RX'
  | 'RX_BAJO'
  | 'RX_NORMAL'
  | 'REINICIO_ROUTER'
  | 'CONTADORES_A_CERO'
  | 'POSIBLE_REREGISTRO'
  | 'RAFAGA_OMCI'
  | 'WAN_RECONEXION'
  | 'WAN_CAIDA'
  | 'WAN_OK'
  | 'TEMP_ALTA'
  | 'ERROR_LECTURA'
  | 'SIN_DATOS'
  | 'SESION'
  | 'INFO';

export type Severity = 'info' | 'aviso' | 'alerta';

export function severityOf(kind: EventKind): Severity {
  switch (kind) {
    case 'PON_CAIDA': case 'REINICIO_ROUTER': case 'WAN_CAIDA': case 'SESION': case 'SIN_DATOS':
      return 'alerta';
    case 'SALTO_RX': case 'RX_BAJO': case 'POSIBLE_REREGISTRO': case 'CONTADORES_A_CERO': case 'TEMP_ALTA': case 'WAN_RECONEXION':
      return 'aviso';
    default:
      return 'info';
  }
}

export interface MonEvent {
  t: number;
  kind: EventKind;
  sev: Severity;
  msg: string;
}

/** Entrada de la lista en pantalla: agrupa repeticiones del mismo evento */
export interface DisplayEvent extends MonEvent {
  count: number;
  first: number;
}

/** Clave de agrupación: tipo + mensaje sin números (así "OMCI +7 en 8s" y "OMCI +9 en 5s" cuentan como el mismo) */
export function dedupeKey(kind: EventKind, msg: string): string {
  return kind + '|' + msg.replace(/[-+]?\d+(?:[.,]\d+)?/g, '#');
}
/** Se agrupa con una entrada reciente (entre las últimas N y dentro de esta ventana) */
const DEDUPE_LOOKBACK = 12;
const DEDUPE_WINDOW_MS = 15 * 60_000;

export interface Thresholds {
  rxLow: number; // dBm: por debajo se considera RX bajo
  rxJump: number; // dB entre dos lecturas
  tempHigh: number; // °C
}

export const DEFAULT_THRESHOLDS: Thresholds = { rxLow: -26, rxJump: 3, tempHigh: 70 };

export interface Rates {
  downBps: number | null; // bits/s
  upBps: number | null;
  downPps: number | null;
  upPps: number | null;
  omciPerMin: number | null; // ritmo medio desde el inicio
}

const WRAP32 = 2 ** 32;
/** Huecos mayores que esto entre lecturas no cuentan para los tiempos (monitor parado, pausa...) */
export const MAX_CONTINUOUS_GAP_S = 60;
/** Tras recuperar el registro, la OLT sigue configurando la ONU: sus ráfagas OMCI no cuentan aparte */
const RECOVERY_GRACE_MS = 60_000;

/** Delta de un contador de 32 bits que puede dar la vuelta */
export function counterDelta(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null) return null;
  return cur >= prev ? cur - prev : cur + WRAP32 - prev;
}

export const rxKey = (rx: number) => rx.toFixed(2);

export class Tracker {
  readonly samples: PonSample[] = [];
  readonly events: DisplayEvent[] = [];
  readonly maxSamples: number;
  readonly th: Thresholds;
  rates: Rates = { downBps: null, upBps: null, downPps: null, upPps: null, omciPerMin: null };
  stats = { ponDrops: 0, rxJumps: 0, reboots: 0, reregs: 0, wanDrops: 0, errors: 0, omciBursts: 0, wanReconnects: 0 };
  /** Tiempos acumulados (s) solo sobre tramos continuos */
  time = { total: 0, o5: 0, rxLow: 0, down: 0 };
  /** Tiempo (s) en cada nivel de RX (clave: dBm con 2 decimales) */
  rxLevels = new Map<string, number>();
  rxMin: number | null = null;
  rxMax: number | null = null;
  private dropStart: number | null = null;
  private lowStart: number | null = null;
  private rxIsLow = false;
  private tempIsHigh = false;
  private errStreak = 0;
  private omciBase: { t: number; v: number } | null = null;
  /** Última RX válida (para detectar saltos que ocurren durante un corte) */
  private lastRx: number | null = null;
  /** Hora de la última recuperación del registro (la OLT sigue configurando la ONU un rato después) */
  private lastRecovery = -Infinity;

  constructor(opts: { maxSamples?: number; thresholds?: Partial<Thresholds>; onEvent?: (e: MonEvent) => void } = {}) {
    this.maxSamples = opts.maxSamples ?? 3000;
    this.th = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
    this.onEvent = opts.onEvent ?? (() => {});
  }
  private onEvent: (e: MonEvent) => void;

  get last(): PonSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  emit(kind: EventKind, msg: string, t = Date.now()): MonEvent {
    const e: MonEvent = { t, kind, sev: severityOf(kind), msg };
    this.onEvent(e); // el registro y los avisos reciben cada ocurrencia
    this.addDisplay(e);
    return e;
  }

  private addDisplay(e: MonEvent): void {
    const key = dedupeKey(e.kind, e.msg);
    const from = Math.max(0, this.events.length - DEDUPE_LOOKBACK);
    for (let i = this.events.length - 1; i >= from; i--) {
      const d = this.events[i]!;
      if (e.t - d.t > DEDUPE_WINDOW_MS) break;
      if (dedupeKey(d.kind, d.msg) === key) {
        this.events.splice(i, 1);
        this.events.push({ ...e, count: d.count + 1, first: d.first });
        return;
      }
    }
    this.events.push({ ...e, count: 1, first: e.t });
    if (this.events.length > 500) this.events.shift();
  }

  error(msg: string): void {
    this.stats.errors++;
    this.errStreak++;
    this.emit('ERROR_LECTURA', msg);
    if (this.errStreak === 3) this.emit('SIN_DATOS', 'Tres lecturas seguidas fallidas: el router no responde');
  }

  /** Añade una muestra y devuelve los eventos que ha generado */
  push(s: PonSample): MonEvent[] {
    const prev = this.last;
    const ev: MonEvent[] = [];
    const add = (k: EventKind, m: string) => ev.push(this.emit(k, m, s.t));
    if (this.errStreak >= 3) add('INFO', 'El router vuelve a responder');
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
        if (prev.state === 'O5') this.time.o5 += dt; else this.time.down += dt;
        if (prev.rx !== null) {
          const k = rxKey(prev.rx);
          this.rxLevels.set(k, (this.rxLevels.get(k) ?? 0) + dt);
          if (prev.rx < this.th.rxLow) this.time.rxLow += dt;
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
      } else if (prev.state !== 'O5' && s.state === 'O5') {
        const dur = this.dropStart ? ` tras ${fmtDur((s.t - this.dropStart) / 1000)}` : '';
        this.dropStart = null;
        this.lastRecovery = s.t;
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
      } else if (reset) {
        add('CONTADORES_A_CERO', 'Contadores PON reiniciados');
        this.omciBase = null;
      }

      // Reconexión del PPPoE entre dos lecturas: su uptime vuelve a empezar sin que lo hayamos visto caído
      const sameWan = !!prev.wan && !!s.wan && prev.wan.name === s.wan.name;
      const pu = prev.wan?.uptime ?? null, cu = s.wan?.uptime ?? null;
      const wanBothUp = prev.wan?.status === 'Connected' && s.wan?.status === 'Connected';
      const wanReconnected = !rebooted && sameWan && wanBothUp && pu !== null && cu !== null && cu < pu;
      if (wanReconnected) {
        this.stats.wanReconnects++;
        add('WAN_RECONEXION', `${s.wan!.type} reconectado entre dos lecturas (llevaba ${fmtDur(pu!)}, ahora ${fmtDur(cu!)})`);
      }

      // Ráfaga de OMCI muy por encima del ritmo normal (si el contador baja es que se ha reiniciado)
      const dOmciUp = prev.omciUp !== null && s.omciUp !== null && s.omciUp >= prev.omciUp ? s.omciUp - prev.omciUp : null;
      const dOmci = prev.omciDown !== null && s.omciDown !== null && s.omciDown >= prev.omciDown ? s.omciDown - prev.omciDown : null;
      // ya explicado por la caída/recuperación (incluido el primer minuto tras recuperarse)
      const partOfDrop = prev.state !== 'O5' || s.state !== 'O5' || s.t - this.lastRecovery <= RECOVERY_GRACE_MS;
      if (!rebooted && !reset && !partOfDrop && dOmci !== null && dOmci > 5 + dt / 60) {
        // Solo cuenta como re-registro si hay algún indicio de corte; si no, es la OLT consultando o
        // configurando la ONU (p. ej. la recogida de estadísticas cada 15 minutos)
        const why: string[] = [];
        if (prev.onuId !== null && s.onuId !== null && prev.onuId !== s.onuId) why.push(`ONU ID ${prev.onuId} → ${s.onuId}`);
        if (wanReconnected) why.push('el PPPoE se ha reconectado');
        const counts = `OMCI +${dOmciUp ?? '?'}/+${dOmci} en ${fmtDur(dt)}`;
        if (why.length) {
          this.stats.reregs++;
          add('POSIBLE_REREGISTRO', `${counts}; ${why.join(', ')}`);
        } else {
          this.stats.omciBursts++;
          add('RAFAGA_OMCI', `${counts} sin corte (consulta de la OLT)`);
        }
      }

      // WAN
      // (solo cuentan las entradas y salidas de Connected; Disconnected → Connecting es la misma caída;
      // y si cambia la conexión que se está mirando, no se comparan estados de conexiones distintas)
      const pw = prev.wan?.status, cw = s.wan?.status;
      const wanChanged =
        (!!prev.wan?.name && !!s.wan?.name && prev.wan.name !== s.wan.name) ||
        (!!prev.wan?.type && !!s.wan?.type && prev.wan.type !== s.wan.type); // registros antiguos, sin nombre
      if (pw && cw && pw !== cw && !wanChanged) {
        if (cw === 'Connected') add('WAN_OK', `WAN conectada (${s.wan?.ip || 'sin IP'})`);
        else if (pw === 'Connected') { this.stats.wanDrops++; add('WAN_CAIDA', `WAN: ${pw} → ${cw}`); }
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
      } else if (this.rxIsLow && s.rx >= this.th.rxLow + 1) {
        this.rxIsLow = false;
        const dur = this.lowStart ? ` tras ${fmtDur((s.t - this.lowStart) / 1000)}` : '';
        add('RX_NORMAL', `RX ${s.rx.toFixed(2)} dBm, recuperada${dur}`);
      }
    }
    if (s.temp !== null) {
      if (!this.tempIsHigh && s.temp > this.th.tempHigh) { this.tempIsHigh = true; add('TEMP_ALTA', `Temperatura del transceptor ${s.temp.toFixed(1)} °C`); }
      else if (this.tempIsHigh && s.temp < this.th.tempHigh - 3) this.tempIsHigh = false;
    }

    if (s.omciDown !== null) {
      if (!this.omciBase) this.omciBase = { t: s.t, v: s.omciDown };
      const mins = (s.t - this.omciBase.t) / 60000;
      this.rates.omciPerMin = mins >= 1 ? (s.omciDown - this.omciBase.v) / mins : null;
    }

    if (s.rx !== null) this.lastRx = s.rx;
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.shift();
    return ev;
  }

  /** Niveles de RX ordenados por tiempo, con porcentaje */
  topLevels(n = 3): { rx: string; pct: number }[] {
    const total = [...this.rxLevels.values()].reduce((a, b) => a + b, 0);
    if (!total) return [];
    return [...this.rxLevels].sort((a, b) => b[1] - a[1]).slice(0, n).map(([rx, t]) => ({ rx, pct: (t / total) * 100 }));
  }
}

export function fmtDur(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
