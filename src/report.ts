// Informe a partir de los registros JSONL: disponibilidad, caídas, niveles de RX y un texto para la avería
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Tracker, MAX_CONTINUOUS_GAP_S, type MonEvent, type Thresholds } from './monitor.js';
import type { PonSample } from './pon.js';

type Rec = Record<string, unknown>;

export function loadRecords(paths: string[]): Rec[] {
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`No existe: ${p}`);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (/^pon-.*\.jsonl$/.test(f)) files.push(join(p, f));
    } else files.push(p);
  }
  if (!files.length) throw new Error('No hay ficheros de registro (pon-*.jsonl)');
  const out: Rec[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Rec); } catch { /* línea cortada: se ignora */ }
    }
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Convierte un registro (formato actual o el de la v0.1) en muestra */
function toSample(r: Rec): PonSample | null {
  const isSample = r['type'] === 'sample' || (r['type'] === undefined && typeof r['state'] === 'string');
  if (!isSample) return null;
  const t = Date.parse(String(r['t']));
  if (!Number.isFinite(t)) return null;
  const wan = r['wan'] as { status?: string; ip?: string; type?: string; name?: string; uptime?: number | null } | null | undefined;
  return {
    t, ponType: (r['ponType'] as string) ?? null, onuId: (r['onuId'] as string) ?? null, statusCode: null,
    state: String(r['state']), rx: num(r['rx']), rxRaw: num(r['rxRaw']), tx: num(r['tx']), temp: num(r['temp']),
    vcc: num(r['vcc']), bias: num(r['bias']), fecUs: null, fecDs: null,
    bytesUp: num(r['bytesUp']), bytesDown: num(r['bytesDown']), pktsUp: num(r['pktsUp']), pktsDown: num(r['pktsDown']),
    omciUp: num(r['omciUp']), omciDown: num(r['omciDown']), uptime: num(r['uptime']), cpu: num(r['cpu']), mem: num(r['mem']),
    wan: wan ? { name: wan.name ?? '', type: wan.type ?? '', status: wan.status ?? '', ip: wan.ip ?? '', gateway: '', uptime: num(wan.uptime) } : null,
  };
}

const nf = (v: number, d = 2) => v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number) => nf(v, v >= 99.95 || v < 0.05 ? 0 : v >= 99 ? 2 : 1) + ' %';
const fecha = (t: number) => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hora = (t: number) => new Date(t).toLocaleTimeString('es-ES', { hour12: false });
const fechaCorta = (t: number) => new Date(t).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function durLarga(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m && !d) parts.push(`${m} min`);
  if (s && !d && !h) parts.push(`${s} s`);
  return parts.join(' ') || '0 s';
}

export interface ReportData {
  start: number;
  end: number;
  samples: number;
  medianInterval: number;
  meta: Rec | null;
  observed: number; // s con datos continuos
  o5: number;
  rxLow: number;
  rxMin: number | null;
  rxMax: number | null;
  rxMedian: number | null;
  levels: { rx: string; secs: number; pct: number }[];
  drops: { start: number; end: number | null; dur: number | null; rxBefore: number | null; state: string }[];
  jumps: { t: number; msg: string }[];
  reregs: number;
  omciBursts: number;
  wanReconnects: number;
  reboots: number;
  wanDrops: number;
  gaps: { start: number; end: number }[];
  liveEvents: Record<string, number>;
  th: Thresholds;
  ponType: string | null;
  onuId: string | null;
}

export function analyze(records: Rec[], thresholds: Partial<Thresholds> = {}): ReportData {
  const samples = records.map(toSample).filter((s): s is PonSample => s !== null).sort((a, b) => a.t - b.t);
  if (!samples.length) throw new Error('Los registros no contienen lecturas');
  const evs: MonEvent[] = [];
  const tr = new Tracker({ maxSamples: 5, thresholds, onEvent: e => evs.push(e) });
  const gaps: { start: number; end: number }[] = [];
  const intervals: number[] = [];
  let prev: PonSample | null = null;
  for (const s of samples) {
    if (prev) {
      const dt = (s.t - prev.t) / 1000;
      if (dt <= 0) continue; // duplicada
      if (dt > MAX_CONTINUOUS_GAP_S) gaps.push({ start: prev.t, end: s.t });
      else intervals.push(dt);
    }
    tr.push(s);
    prev = s;
  }

  // Caídas: pares PON_CAIDA → PON_RECUPERADA
  const drops: ReportData['drops'] = [];
  for (const e of evs) {
    if (e.kind === 'PON_CAIDA') {
      const m = e.msg.match(/RX previo (-?[\d.]+)/);
      drops.push({ start: e.t, end: null, dur: null, rxBefore: m ? Number(m[1]) : null, state: e.msg.match(/→ (\S+)/)?.[1] ?? '?' });
    } else if (e.kind === 'PON_RECUPERADA') {
      const d = drops[drops.length - 1];
      if (d && d.end === null) { d.end = e.t; d.dur = (e.t - d.start) / 1000; }
    }
  }

  const levelsTotal = [...tr.rxLevels.values()].reduce((a, b) => a + b, 0);
  const levels = [...tr.rxLevels].sort((a, b) => b[1] - a[1]).map(([rx, secs]) => ({ rx, secs, pct: levelsTotal ? (secs / levelsTotal) * 100 : 0 }));
  let rxMedian: number | null = null;
  if (levelsTotal) {
    let acc = 0;
    for (const [rx, secs] of [...tr.rxLevels].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      acc += secs;
      if (acc >= levelsTotal / 2) { rxMedian = Number(rx); break; }
    }
  }

  const liveEvents: Record<string, number> = {};
  for (const r of records) {
    const kind = (r['type'] === 'event' ? r['kind'] : r['event']) as string | undefined;
    if (kind && ['SESION', 'SIN_DATOS', 'ERROR_LECTURA'].includes(kind)) liveEvents[kind] = (liveEvents[kind] ?? 0) + 1;
    if (r['type'] === 'error' || (r['type'] === undefined && r['error'])) liveEvents['ERROR_LECTURA'] = (liveEvents['ERROR_LECTURA'] ?? 0) + 1;
  }

  intervals.sort((a, b) => a - b);
  const last = samples[samples.length - 1]!;
  return {
    start: samples[0]!.t, end: last.t, samples: samples.length,
    medianInterval: intervals.length ? intervals[Math.floor(intervals.length / 2)]! : 0,
    meta: (records.find(r => r['type'] === 'meta') as Rec | undefined) ?? null,
    observed: tr.time.total, o5: tr.time.o5, rxLow: tr.time.rxLow,
    rxMin: tr.rxMin, rxMax: tr.rxMax, rxMedian, levels, drops,
    jumps: evs.filter(e => e.kind === 'SALTO_RX').map(e => ({ t: e.t, msg: e.msg })),
    reregs: tr.stats.reregs, omciBursts: tr.stats.omciBursts, wanReconnects: tr.stats.wanReconnects,
    reboots: tr.stats.reboots, wanDrops: tr.stats.wanDrops,
    gaps, liveEvents, th: tr.th, ponType: last.ponType, onuId: last.onuId,
  };
}

export function renderReport(d: ReportData): string {
  const L: string[] = [];
  const meta = d.meta ?? {};
  const dev = (meta['devInfo'] ?? {}) as Rec;
  const model = [dev['modelName'], dev['softwareVersion'] ? `firmware ${dev['softwareVersion']}` : null].filter(Boolean).join(' · ') || (meta['model'] as string) || 'router';
  const avail = d.observed ? (d.o5 / d.observed) * 100 : 100;
  const downTotal = d.drops.reduce((a, x) => a + (x.dur ?? 0), 0);
  const longest = d.drops.reduce((a, x) => Math.max(a, x.dur ?? 0), 0);
  const gapTotal = d.gaps.reduce((a, g) => a + (g.end - g.start) / 1000, 0);
  const lowPct = d.observed ? (d.rxLow / d.observed) * 100 : 0;
  const dbm = (v: number | null) => (v === null ? '--' : `${nf(v)} dBm`);

  L.push('# Informe de la conexión de fibra', '');
  L.push(`**Periodo:** ${fecha(d.start)} – ${fecha(d.end)} (${durLarga((d.end - d.start) / 1000)})  `);
  L.push(`**Lecturas:** ${d.samples.toLocaleString('es-ES')}, cada ~${Math.round(d.medianInterval)} s${d.gaps.length ? `; ${d.gaps.length} hueco(s) sin datos (${durLarga(gapTotal)})` : ''}  `);
  L.push(`**Equipo:** ${model} · ${d.ponType ?? 'PON'} · ONU ID ${d.onuId ?? '?'}`, '');

  L.push('## Resumen', '', '| Indicador | Valor |', '|---|---|');
  L.push(`| Disponibilidad del registro PON (O5) | ${pct(avail)} |`);
  L.push(`| Pérdidas de registro (caídas de la fibra) | ${d.drops.length}${d.drops.length ? ` (${durLarga(downTotal)} en total; la más larga ${durLarga(longest)})` : ''} |`);
  L.push(`| Potencia recibida (RX) | mín ${dbm(d.rxMin)} · mediana ${dbm(d.rxMedian)} · máx ${dbm(d.rxMax)} |`);
  L.push(`| Tiempo con RX por debajo de ${d.th.rxLow} dBm | ${durLarga(d.rxLow)} (${pct(lowPct)}) |`);
  L.push(`| Cambios bruscos de RX (≥ ${d.th.rxJump} dB) | ${d.jumps.length} |`);
  L.push(`| Posibles re-registros de la ONU | ${d.reregs} |`);
  L.push(`| Caídas de la conexión WAN (PPPoE) | ${d.wanDrops}${d.wanReconnects ? ` (+${d.wanReconnects} reconexiones cortas entre lecturas)` : ''} |`);
  L.push(`| Ráfagas OMCI sin corte (consultas de la OLT, normales) | ${d.omciBursts} |`);
  L.push(`| Reinicios del router | ${d.reboots} |`);
  if (d.liveEvents['SESION'] || d.liveEvents['SIN_DATOS']) L.push(`| Incidencias del propio monitor | ${d.liveEvents['SESION'] ?? 0} sesiones perdidas, ${d.liveEvents['SIN_DATOS'] ?? 0} periodos sin respuesta |`);
  L.push('');

  if (d.levels.length) {
    L.push('## Tiempo en cada nivel de RX', '', '```');
    const shown = d.levels.slice(0, 8);
    for (const lv of shown) {
      const bar = '█'.repeat(Math.round(lv.pct / 5)).padEnd(20, '░');
      L.push(`${nf(Number(lv.rx)).padStart(7)} dBm  ${bar} ${nf(lv.pct, 1).padStart(5)} %  (${durLarga(lv.secs)})`);
    }
    if (d.levels.length > shown.length) L.push(`(${d.levels.length - shown.length} niveles más con menos tiempo)`);
    L.push('```', '');
  }

  if (d.drops.length) {
    L.push('## Pérdidas de registro', '', '| Inicio | Duración | Estado | RX antes |', '|---|---|---|---|');
    for (const x of d.drops.slice(0, 100)) L.push(`| ${fechaCorta(x.start)} | ${x.dur === null ? 'sin recuperar al final del registro' : durLarga(x.dur)} | ${x.state} | ${dbm(x.rxBefore)} |`);
    if (d.drops.length > 100) L.push(`| … | ${d.drops.length - 100} más | | |`);
    L.push('');
  }

  if (d.jumps.length) {
    L.push('## Cambios bruscos de potencia RX', '', '| Hora | Cambio |', '|---|---|');
    for (const j of d.jumps.slice(0, 100)) L.push(`| ${fechaCorta(j.t)} | ${j.msg} |`);
    if (d.jumps.length > 100) L.push(`| … | ${d.jumps.length - 100} más |`);
    L.push('');
  }

  if (d.gaps.length) {
    L.push('## Huecos sin datos', '', 'Periodos en los que el monitor no estaba leyendo (no cuentan para los porcentajes).', '');
    for (const g of d.gaps.slice(0, 20)) L.push(`- ${fechaCorta(g.start)} → ${hora(g.end)} (${durLarga((g.end - g.start) / 1000)})`);
    L.push('');
  }

  L.push('## Texto para la avería', '');
  L.push('> ' + digiText(d, avail, lowPct, downTotal).join(' '), '');
  return L.join('\n');
}

function digiText(d: ReportData, avail: number, lowPct: number, downTotal: number): string[] {
  const t: string[] = [];
  const dbm = (v: number) => `${nf(v)} dBm`;
  t.push(`He monitorizado de forma automática la ONU (${d.ponType ?? 'PON'}, ONU ID ${d.onuId ?? '?'}) entre el ${fecha(d.start)} y el ${fecha(d.end)}, con lecturas cada ${Math.round(d.medianInterval)} segundos.`);
  if (d.drops.length) {
    t.push(`En ese periodo la ONU perdió el registro con la OLT ${d.drops.length} ${d.drops.length === 1 ? 'vez' : 'veces'}, con ${durLarga(downTotal)} sin servicio en total (disponibilidad del ${pct(avail)}).`);
  } else {
    t.push('En ese periodo la ONU no perdió el registro con la OLT.');
  }
  if (d.rxMin !== null && d.rxMax !== null) {
    if (d.rxMax - d.rxMin >= d.th.rxJump) {
      t.push(`La potencia óptica recibida osciló entre ${dbm(d.rxMin)} y ${dbm(d.rxMax)}${d.jumps.length ? `, con ${d.jumps.length} cambios bruscos de ${d.th.rxJump} dB o más sin ninguna manipulación en el domicilio` : ''}.`);
    } else if (d.rxMax === d.rxMin) {
      t.push(`La potencia óptica recibida se mantuvo estable en ${dbm(d.rxMin)}.`);
    } else {
      t.push(`La potencia óptica recibida se mantuvo entre ${dbm(d.rxMin)} y ${dbm(d.rxMax)}.`);
    }
    if (lowPct >= 0.1) t.push(`Estuvo por debajo de ${d.th.rxLow} dBm el ${pct(lowPct)} del tiempo, muy cerca del límite de sensibilidad del receptor XGS-PON (unos -28 dBm).`);
  }
  if (d.reregs) t.push(`Se detectaron además ${d.reregs} posibles re-registros de la ONU sin pérdida de registro visible (ráfagas de mensajes OMCI acompañadas de reconexión del PPPoE o cambio de ONU ID).`);
  const wanTotal = d.wanDrops + d.wanReconnects;
  if (wanTotal) t.push(`La conexión PPPoE se cayó o se reconectó ${wanTotal} ${wanTotal === 1 ? 'vez' : 'veces'}.`);
  if (d.drops.length || d.jumps.length || lowPct >= 1 || d.reregs) {
    t.push('Ya he descartado el latiguillo y los conectores de casa. El comportamiento apunta a una atenuación excesiva o intermitente en la red óptica (roseta, acometida, CTO o empalmes), por lo que solicito una revisión de la línea con medición de potencia. Puedo facilitar el registro detallado.');
  }
  return t;
}

/** Rutas por defecto: carpeta pon-logs o ficheros pon-*.jsonl del directorio actual */
export function defaultReportPaths(): string[] {
  if (existsSync('pon-logs') && statSync('pon-logs').isDirectory()) return ['pon-logs'];
  return readdirSync('.').filter(f => /^pon-.*\.jsonl$/.test(f)).sort();
}
