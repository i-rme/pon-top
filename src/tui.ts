// Pantalla tipo htop en ANSI puro (sin dependencias)
import type { Tracker, MonEvent } from './monitor.js';
import { fmtDur } from './monitor.js';
import type { PonSample } from './pon.js';

export interface ViewState {
  host: string;
  model: string | null;
  intervalSec: number;
  paused: boolean;
  connected: boolean;
  busy: boolean;
  message: string | null;
  logPath: string | null;
  startedAt: number;
  color: boolean;
  /** Último aviso (se muestra como banner un rato) */
  alert: MonEvent | null;
  muted: boolean;
  rawView: boolean;
  notifyDesc: string;
}

const BANNER_MS = 90_000;

export const RX_SENSITIVITY = -28; // dBm, límite aproximado del receptor XGS-PON (clase N1)
const RX_GOOD = -24;
const SPARK_MIN = -30;
const SPARK_MAX = -14;

const ESC = '\x1b[';
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visLen = (s: string) => [...s.replace(ANSI_RE, '')].length;

function padR(s: string, w: number): string {
  const l = visLen(s);
  return l >= w ? s : s + ' '.repeat(w - l);
}
function truncate(s: string, w: number): string {
  if (visLen(s) <= w) return s;
  // corte simple respetando secuencias ANSI
  let out = '', n = 0;
  for (const part of s.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (part.startsWith('\x1b[')) { out += part; continue; }
    for (const ch of part) { if (n >= w - 1) return out + '…' + (out.includes('\x1b[') ? ESC + '0m' : ''); out += ch; n++; }
  }
  return out;
}

export class Painter {
  constructor(private enabled: boolean) {}
  c = (code: string, s: string) => (this.enabled ? `${ESC}${code}m${s}${ESC}0m` : s);
  bold = (s: string) => this.c('1', s);
  dim = (s: string) => this.c('2', s);
  red = (s: string) => this.c('31', s);
  green = (s: string) => this.c('32', s);
  yellow = (s: string) => this.c('33', s);
  cyan = (s: string) => this.c('36', s);
  inverse = (s: string) => this.c('7', s);
}

const f = (v: number | null | undefined, d = 2, unit = '') => (v === null || v === undefined ? '--' : v.toFixed(d) + unit);

export function fmtBits(bps: number | null): string {
  if (bps === null) return '--';
  const u = ['b/s', 'kb/s', 'Mb/s', 'Gb/s'];
  let i = 0;
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
  return `${bps.toFixed(bps < 10 && i > 0 ? 2 : 1)} ${u[i]}`;
}
function fmtCount(n: number | null): string {
  if (n === null) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}
function hhmmss(t: number): string {
  return new Date(t).toLocaleTimeString('es-ES', { hour12: false });
}

function rxColor(p: Painter, rx: number | null): (s: string) => string {
  if (rx === null) return p.red;
  if (rx >= RX_GOOD) return p.green;
  if (rx >= RX_SENSITIVITY + 1) return p.yellow;
  return p.red;
}

function gauge(p: Painter, rx: number | null, width: number): string {
  const lo = -32, hi = -8;
  const frac = rx === null ? 0 : Math.min(1, Math.max(0, (rx - lo) / (hi - lo)));
  const full = Math.round(frac * width);
  const mark = Math.round(((RX_SENSITIVITY - lo) / (hi - lo)) * width);
  let bar = '';
  for (let i = 0; i < width; i++) {
    const ch = i < full ? '█' : i === mark ? '┊' : '░';
    bar += ch;
  }
  return '[' + rxColor(p, rx)(bar.slice(0, full)) + p.dim(bar.slice(full)) + ']';
}

const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(p: Painter, samples: PonSample[], width: number): string {
  const tail = samples.slice(-width);
  let out = '';
  for (const s of tail) {
    if (s.state !== 'O5') { out += p.red('✖'); continue; }
    if (s.rx === null) { out += p.red('·'); continue; }
    const frac = Math.min(1, Math.max(0, (s.rx - SPARK_MIN) / (SPARK_MAX - SPARK_MIN)));
    const ch = SPARK[Math.min(SPARK.length - 1, Math.floor(frac * SPARK.length))]!;
    out += rxColor(p, s.rx)(ch);
  }
  return out + ' '.repeat(Math.max(0, width - tail.length));
}

function eventColor(p: Painter, e: MonEvent): (s: string) => string {
  switch (e.kind) {
    case 'ERROR_LECTURA': return p.red;
    case 'PON_RECUPERADA': case 'WAN_OK': case 'RX_NORMAL': return p.green;
    default: return e.sev === 'alerta' ? p.red : e.sev === 'aviso' ? p.yellow : p.dim;
  }
}

export function renderFrame(tr: Tracker, v: ViewState, cols: number, rows: number): string[] {
  const p = new Painter(v.color);
  const W = Math.max(60, cols);
  const s = tr.last;
  const L: string[] = [];
  const rule = () => L.push(p.dim('─'.repeat(W)));

  // Cabecera
  const live = !v.connected ? p.red('✖ sin sesión') : v.paused ? p.yellow('⏸ en pausa') : v.busy ? p.cyan('● leyendo') : p.green('● en vivo');
  const left = ` ${p.bold('pon-top')}  ${v.host}${v.model ? '  ' + v.model : ''}`;
  const right = `${hhmmss(Date.now())} · cada ${v.intervalSec}s · ${live} `;
  L.push(p.inverse(padR(left, W - visLen(right)) + right));
  if (v.alert && Date.now() - v.alert.t < BANNER_MS) {
    const col = v.alert.sev === 'alerta' ? (x: string) => p.c('1;97;41', x) : v.alert.sev === 'aviso' ? (x: string) => p.c('30;43', x) : (x: string) => p.c('30;42', x);
    L.push(col(padR(` ${v.alert.sev === 'info' ? '✔' : '⚠'} ${hhmmss(v.alert.t)}  ${v.alert.kind}  ${v.alert.msg}`, W)));
  }

  if (!s) {
    L.push('', '  Esperando la primera lectura…');
  } else {
    const ok = s.state === 'O5';
    const st = ok ? p.green(p.bold(`${s.state} registrada`)) : p.red(p.bold(`${s.state} ${s.state === 'DESC' ? 'sin fibra' : 'NO registrada'}`));
    L.push(` ${p.bold('PON')}   ${s.ponType ?? '--'}   ONU ${s.onuId ?? '--'}   ${st}   ${p.dim('FEC')} ↑${s.fecUs ? 'On' : 'Off'} ↓${s.fecDs ? 'On' : 'Off'}`);

    const rxs = rxColor(p, s.rx)(p.bold(f(s.rx, 2, ' dBm').padStart(10)));
    const margin = s.rx === null ? '--' : (s.rx - RX_SENSITIVITY).toFixed(1) + ' dB';
    const gw = Math.max(10, W - 46);
    L.push(` ${p.bold('RX')}  ${rxs}  ${gauge(p, s.rx, gw)}  margen ${rxColor(p, s.rx)(margin)}`);
    const rawTxt = s.rxRaw === null ? '' : p.dim(`  (${(s.rxRaw / 10).toFixed(1)} µW)`);
    L.push(`      ${p.dim('mín')} ${f(tr.rxMin)}  ${p.dim('máx')} ${f(tr.rxMax)}${rawTxt}`);
    const spW = Math.max(10, W - 8);
    L.push(`      ${sparkline(p, tr.samples, spW)}`);
    L.push(`      ${p.dim(`escala ${SPARK_MIN}…${SPARK_MAX} dBm · ✖ = no registrada · últimas ${Math.min(spW, tr.samples.length)} lecturas`)}`);
    L.push(` ${p.bold('TX')}  ${f(s.tx, 2, ' dBm').padStart(10)}   Temp ${f(s.temp, 1, ' °C')}   Vcc ${s.vcc === null ? '--' : (s.vcc / 1000).toFixed(3) + ' V'}   Bias ${f(s.bias, 2, ' mA')}`);
    rule();

    const r = tr.rates;
    L.push(` ${p.bold('Tráfico')}  ↓ ${fmtBits(r.downBps).padStart(11)}  ↑ ${fmtBits(r.upBps).padStart(11)}   ${p.dim('pkts')} ↓ ${fmtCount(r.downPps)}/s ↑ ${fmtCount(r.upPps)}/s`);
    const omciRate = r.omciPerMin === null ? '' : p.dim(`  (${r.omciPerMin.toFixed(1)}/min)`);
    L.push(` ${p.bold('OMCI')}     ↑ ${fmtCount(s.omciUp)}  ↓ ${fmtCount(s.omciDown)}${omciRate}   ${p.dim('PON total')} ↓ ${fmtCount(s.pktsDown)} ↑ ${fmtCount(s.pktsUp)} pkts`);
    const wan = s.wan
      ? `${s.wan.type} ${s.wan.status === 'Connected' ? p.green(s.wan.status) : p.red(s.wan.status)} ${s.wan.ip}`
      : '--';
    L.push(` ${p.bold('Router')}   uptime ${s.uptime === null ? '--' : fmtDur(s.uptime)}   CPU ${f(s.cpu, 0, '%')}   RAM ${f(s.mem, 0, '%')}   WAN ${wan}`);
    rule();

    const st2 = tr.stats;
    const n = (x: number, col: (s: string) => string) => (x ? col(String(x)) : p.dim('0'));
    const sep = p.dim(' · ');
    L.push(
      ` ${p.bold('Sesión')}   ${fmtDur((Date.now() - v.startedAt) / 1000)}${sep}${tr.samples.length} lect.   ` +
        [`caídas ${n(st2.ponDrops, p.red)}`, `saltos RX ${n(st2.rxJumps, p.yellow)}`, `re-reg ${n(st2.reregs, p.yellow)}`,
          `reinicios ${n(st2.reboots, p.red)}`, `WAN ${n(st2.wanDrops, p.red)}`, `errores ${n(st2.errors, p.red)}`].join(sep),
    );
    const T = tr.time;
    if (T.total > 0) {
      const av = (T.o5 / T.total) * 100;
      const avTxt = (av >= 99.9 ? p.green : av >= 99 ? p.yellow : p.red)(av.toFixed(av >= 99.95 || av === 0 ? 0 : 2) + '%');
      const low = (T.rxLow / T.total) * 100;
      const lowTxt = (low ? p.yellow : p.dim)(`${low.toFixed(low && low < 10 ? 1 : 0)}%`);
      const lv = tr.topLevels(3).map(x => `${x.rx} ${p.dim(x.pct.toFixed(0) + '%')}`).join(p.dim(', '));
      L.push(` ${p.bold('Tiempos')}  disponibilidad ${avTxt}${T.down ? p.dim(` (caída ${fmtDur(T.down)})`) : ''}${sep}RX < ${tr.th.rxLow} ${lowTxt}${sep}niveles RX ${lv}`);
    }
  }
  rule();

  const footer = 2;
  const avail = Math.max(3, rows - L.length - footer - 1);
  if (v.rawView) {
    // Datos tal cual los devuelve el router, en columnas
    L.push(` ${p.bold('Datos en bruto del router')} ${p.dim('(v para volver)')}`);
    const raw = s?.raw;
    const items: string[] = [];
    if (raw) {
      for (const [name, obj] of [['optc', raw.optc], ['stats', raw.stats], ['omci', raw.omci]] as const) {
        for (const [k, val] of Object.entries(obj)) items.push(`${p.dim(name + '.')}${k}=${p.cyan(String(val))}`);
      }
    } else items.push(p.dim('(sin datos en bruto)'));
    const colW = Math.min(48, Math.max(30, Math.floor((W - 2) / 2)));
    const ncol = Math.max(1, Math.floor((W - 2) / colW));
    const nrow = Math.min(avail - 1, Math.ceil(items.length / ncol));
    for (let r = 0; r < nrow; r++) {
      let line = '  ';
      for (let c = 0; c < ncol; c++) { const it = items[c * nrow + r]; if (it) line += padR(truncate(it, colW - 1), colW); }
      L.push(line);
    }
    if (items.length > nrow * ncol) L.push(p.dim(`  … ${items.length - nrow * ncol} campos más (agranda la ventana)`));
  } else {
    // Eventos: ocupan el espacio que quede
    L.push(` ${p.bold('Eventos')}`);
    const evs = tr.events.slice(-avail + 1).reverse();
    if (!evs.length) L.push(p.dim('  (ninguno todavía)'));
    for (const e of evs) {
      // Repeticiones agrupadas: "TIPO (n)" y, al final, desde cuándo
      const col = eventColor(p, e);
      const name = e.count > 1 ? col(e.kind) + ' ' + p.bold(col(`(${e.count})`)) : col(e.kind);
      const since = e.count > 1 ? p.dim(`  · desde ${hhmmss(e.first)}`) : '';
      L.push(`  ${p.dim(hhmmss(e.t))}  ${padR(name, 24)} ${e.msg}${since}`);
    }
  }
  while (L.length < rows - footer) L.push('');

  const info = p.dim(` avisos: ${v.muted ? 'silenciados' : v.notifyDesc}${v.logPath ? ` · registro: ${v.logPath}` : ' · sin registro'}`);
  L.push(v.message ? p.yellow(' ' + v.message) : info);
  const k = (key: string, label: string) => `${p.inverse(` ${key} `)} ${label}`;
  const keys = ' ' + [k('q', 'salir'), k('p', 'pausa'), k('r', 'leer'), k('+/-', 'intervalo'), k('v', v.rawView ? 'eventos' : 'datos'),
    k('m', v.muted ? p.yellow('avisos OFF') : 'silenciar'), k('l', 'reconectar')].join(' ');
  L.push(keys);

  return L.slice(0, rows).map(l => truncate(l, W));
}

export class Screen {
  private active = false;
  constructor(private out: NodeJS.WriteStream) {}
  enter(): void {
    if (this.active) return;
    this.active = true;
    this.out.write(`${ESC}?1049h${ESC}?25l${ESC}H${ESC}2J`);
  }
  draw(lines: string[]): void {
    this.out.write(`${ESC}H` + lines.map(l => l + `${ESC}K`).join('\n') + `${ESC}J`);
  }
  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`);
  }
}
