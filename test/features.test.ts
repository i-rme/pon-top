import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Alerter, maskIps, appleString } from '../src/alerts.ts';
import { Recorder } from '../src/log.ts';
import { analyze, renderReport, loadRecords } from '../src/report.ts';
import type { MonEvent } from '../src/monitor.ts';
import type { PonSample } from '../src/pon.ts';

export function testAlerts(): void {
  let now = 0, bells = 0;
  const sent: string[] = [];
  const hooks: string[] = [];
  const a = new Alerter({ bell: true, desktop: true, webhook: 'https://ntfy.example/x', cooldownSec: 60 }, {
    bell: () => bells++, now: () => now,
    notifyImpl: (t, b) => sent.push(`${t}|${b}`), webhookImpl: (t, b, u) => hooks.push(`${u}|${b}`),
  });
  const ev = (kind: MonEvent['kind'], sev: MonEvent['sev'], msg: string): MonEvent => ({ t: now, kind, sev, msg });
  assert.equal(a.handle(ev('SALTO_RX', 'aviso', 'RX -17.67 → -27.45 dBm')), true);
  now = 30_000;
  assert.equal(a.handle(ev('SALTO_RX', 'aviso', 'otra')), false, 'cooldown');
  assert.equal(a.handle(ev('PON_CAIDA', 'alerta', 'Registro perdido')), true, 'otro tipo sí avisa');
  now = 70_000;
  assert.equal(a.handle(ev('SALTO_RX', 'aviso', 'tercera')), true);
  assert.match(sent[2]!, /\(\+1 similares\)/);
  assert.equal(a.handle(ev('ERROR_LECTURA', 'info', 'timeout')), false, 'errores sueltos no avisan');
  assert.equal(a.handle(ev('WAN_OK', 'info', 'WAN conectada (203.0.113.45)')), true);
  assert.match(sent[3]!, /x\.x\.x\.x/, 'la IP no sale del ordenador');
  assert.doesNotMatch(hooks.join(), /79\.116/);
  assert.equal(bells, 3, 'pitido solo en avisos/alertas');
  assert.ok(hooks[1]!.startsWith('true|'), 'PON_CAIDA es urgente');
  a.muted = true;
  now = 500_000;
  assert.equal(a.handle(ev('PON_CAIDA', 'alerta', 'x')), false, 'silenciado');
  assert.equal(appleString('di "hola" \\ adiós'), '"di \\"hola\\" \\\\ adiós"');
  assert.equal(maskIps('ip 10.0.0.1 y 2001:db8::4f74'), 'ip x.x.x.x y x::x');
  console.log('alerts OK');
}

const sample = (t: number, p: Partial<PonSample> = {}): PonSample => ({
  t, ponType: 'XGSPON', onuId: '131', statusCode: 5, state: 'O5', rx: -17.67, rxRaw: 171, tx: 6, temp: 47.6, vcc: 3333, bias: 17.7,
  fecUs: true, fecDs: true, bytesUp: 1, bytesDown: 1, pktsUp: 1, pktsDown: t / 1000, omciUp: 740, omciDown: 720, uptime: 5000 + t / 1000,
  cpu: 10, mem: 40, wan: { name: 'w', type: 'PPPoE', status: 'Connected', ip: '1.2.3.4', gateway: '' },
  raw: { optc: { RXPower: '171' }, stats: {}, omci: {}, wan: [{ name: 'w', connStatusV4: 'Connected' }] }, ...p,
});

export function testRecorderAndReport(): void {
  const dir = mkdtempSync(join(tmpdir(), 'pon-top-'));
  // reloj controlado: empieza el 20/10 a las 23:59:40 hora local y cruza la medianoche
  let now = new Date(2026, 9, 20, 23, 59, 40).getTime();
  const rec = new Recorder({ dir: join(dir, 'logs'), now: () => now });
  rec.meta({ host: 'http://192.168.1.1', devInfo: { modelName: 'XGB430v Pro', softwareVersion: '0.2.0' } });
  rec.session('login', 'Sesión iniciada');
  const t0 = now;
  for (let i = 0; i <= 120; i++) { // 10 min cada 5 s
    now = t0 + i * 5000;
    let p: Partial<PonSample> = {};
    if (i >= 40 && i < 80) p = { rx: -27.45, rxRaw: 18 }; // tramo con RX bajo
    if (i >= 60 && i < 65) p = { ...p, state: 'O2', statusCode: 2, onuId: '255', tx: null }; // caída de 25 s
    if (i === 65) p = { ...p, omciDown: 729 };
    if (i > 65) p = { ...p, omciDown: 729 };
    rec.sample(sample(now, p));
    if (i === 30) rec.event({ t: now, kind: 'SESION', sev: 'alerta', msg: 'Sesión perdida' });
  }
  // hueco de 10 minutos con el monitor parado y unas lecturas más
  for (let i = 0; i < 4; i++) { now = t0 + 121 * 5000 + 600_000 + i * 5000; rec.sample(sample(now, { omciDown: 729 })); }
  rec.close();

  const files = readdirSync(join(dir, 'logs')).sort();
  assert.deepEqual(files, ['eventos.log', 'pon-2026-10-20.jsonl', 'pon-2026-10-21.jsonl'], 'rotación a medianoche');
  for (const f of files) assert.equal(statSync(join(dir, 'logs', f)).mode & 0o777, 0o600, `${f} con permisos 600`);
  const day1 = readFileSync(join(dir, 'logs', 'pon-2026-10-20.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(day1[0].type, 'meta');
  assert.ok(day1.some(r => r.type === 'wan'), 'la lista WAN se registra (una vez, porque no cambia)');
  assert.equal(day1.filter(r => r.type === 'wan').length, 1);
  assert.deepEqual(day1.find(r => r.type === 'sample').raw.optc, { RXPower: '171' }, 'datos en bruto en cada lectura');
  assert.match(day1.find(r => r.type === 'sample').t, /^2026-10-20T23:59:40\.000[+-]\d\d:\d\d$/);
  assert.match(readFileSync(join(dir, 'logs', 'eventos.log'), 'utf8'), /\[ALERTA\] SESION/);

  const d = analyze(loadRecords([join(dir, 'logs')]));
  assert.equal(d.samples, 125);
  assert.equal(d.drops.length, 1);
  assert.equal(d.drops[0]!.dur, 25);
  assert.equal(d.drops[0]!.state, 'O2');
  assert.equal(d.drops[0]!.rxBefore, -27.45);
  assert.equal(d.jumps.length, 2);
  assert.equal(d.reregs, 0, 'la ráfaga OMCI de la recuperación forma parte de la caída');
  assert.equal(d.gaps.length, 1);
  assert.equal(d.observed, 600 + 15);
  assert.equal(d.observed - d.o5, 25);
  assert.equal(d.rxLow, 200);
  assert.equal(d.rxMin, -27.45);
  assert.equal(d.rxMedian, -17.67);
  assert.equal(d.liveEvents['SESION'], 1);
  const md = renderReport(d);
  assert.match(md, /Disponibilidad del registro PON \(O5\) \| 95,9 %/);
  assert.match(md, /Pérdidas de registro \(caídas de la fibra\) \| 1 \(25 s en total; la más larga 25 s\)/);
  assert.match(md, /perdió el registro con la OLT 1 vez/);
  assert.match(md, /-27,45 dBm/);
  assert.match(md, /XGB430v Pro · firmware 0\.2\.0/);

  // Compatibilidad con el formato de la v0.1 (sin "type")
  const old = analyze([
    { t: '2026-10-20T09:56:23.925Z', state: 'O5', rx: -17.67, omciDown: 724, pktsDown: 1, uptime: 100, ev: [] },
    { t: '2026-10-20T09:56:28.925Z', state: 'O5', rx: -27.45, omciDown: 724, pktsDown: 2, uptime: 105, ev: [] },
    { t: '2026-10-20T09:56:30.000Z', error: 'timeout' },
  ]);
  assert.equal(old.samples, 2);
  assert.equal(old.jumps.length, 1);
  assert.equal(old.liveEvents['ERROR_LECTURA'], 1);
  console.log('recorder + report OK');
}
