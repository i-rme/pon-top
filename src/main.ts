#!/usr/bin/env node
// pon-top: monitor tipo htop del estado PON del TP-Link XGB430v Pro (Digi)
import { appendFileSync, writeFileSync } from 'node:fs';
import { RouterClient, RouterError, normalizeBase } from './client.js';
import { readPon, readDevInfo, dumpRaw, type PonSample, type Obj } from './pon.js';
import { Tracker, type MonEvent, type Thresholds, DEFAULT_THRESHOLDS } from './monitor.js';
import { renderFrame, Screen, type ViewState } from './tui.js';
import { promptLine, promptHidden, confirm } from './prompt.js';
import { createDemoSource } from './demo.js';
import { Recorder, isoLocal } from './log.js';
import { Alerter } from './alerts.js';
import { analyze, loadRecords, renderReport, defaultReportPaths } from './report.js';
import { SessionKeeper, type SessionNote } from './session.js';

const VERSION = '0.2.3';
// La release inyecta aquí el número de build y el commit (bun build --define)
declare const __PON_TOP_BUILD__: string | undefined;
const BUILD = typeof __PON_TOP_BUILD__ === 'string' ? __PON_TOP_BUILD__ : null;
const FULL_VERSION = BUILD ? `${VERSION} (${BUILD})` : VERSION;
const DEFAULT_USER = 'user';

interface Args {
  cmd: 'top' | 'dump' | 'report';
  paths: string[];
  host: string;
  user: string | null;
  interval: number;
  logDir: string | null;
  logFile: string | null;
  force: boolean;
  allowPublic: boolean;
  demo: boolean;
  json: boolean;
  relogin: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
  bell: boolean;
  desktop: boolean;
  webhook: string | null;
  cooldown: number;
  th: Thresholds;
  out: string | null;
}

const HELP = `pon-top ${FULL_VERSION} — estado PON del TP-Link XGB430v Pro (Digi) en tiempo real

Uso:
  pon-top [opciones]               monitor interactivo
  pon-top dump [opciones]          vuelca en JSON los datos en bruto y sale
  pon-top report [rutas] [--out f] informe a partir de los registros (por defecto pon-logs/)

Conexión:
  --host <ip>            dirección del router (por defecto 192.168.1.1)
  --user <nombre>        usuario (por defecto: ${DEFAULT_USER}; si no se indica se pregunta)
  -i, --interval <s>     segundos entre lecturas (por defecto 5, mínimo 2)
  --force                cerrar sin preguntar otra sesión abierta en el router
  --no-relogin           no volver a entrar solo cuando el router cierra la sesión
  --allow-public         permitir un host que no sea de red local

Registro (activado por defecto):
  --log-dir <carpeta>    un JSONL por día + eventos.log (por defecto pon-logs)
  --log <fichero>        un único fichero JSONL, sin rotación
  --no-log               no guardar nada

Avisos (pitido + notificación del sistema por defecto):
  --alert-rx <dBm>       avisar si RX baja de este valor (por defecto ${DEFAULT_THRESHOLDS.rxLow})
  --alert-jump <dB>      avisar si RX cambia esto o más entre lecturas (por defecto ${DEFAULT_THRESHOLDS.rxJump})
  --alert-temp <°C>      avisar si el transceptor supera esta temperatura (por defecto ${DEFAULT_THRESHOLDS.tempHigh})
  --webhook <url>        enviar también cada aviso por POST (p. ej. https://ntfy.sh/mi-tema-secreto)
  --cooldown <s>         no repetir el mismo tipo de aviso antes de N segundos (por defecto 60)
  --no-notify            sin notificaciones del sistema
  --no-bell              sin pitido

Otros:
  --json                 sin interfaz: una línea JSON por lectura en stdout
  --demo                 datos simulados, sin router
  --debug                traza del protocolo en pon-top-debug.log (sin secretos)
  --out <fichero>        (report) guardar el informe en Markdown
  -V, --version          versión
  -h, --help             esta ayuda

La contraseña siempre se pide por teclado sin mostrarse; nunca se acepta por
argumento ni variable de entorno y no se guarda en disco.`;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: 'top', paths: [], host: process.env['PON_TOP_HOST'] || '192.168.1.1', user: null, interval: 5,
    logDir: 'pon-logs', logFile: null, force: false, allowPublic: false, demo: false, json: false,
    relogin: true, debug: false, help: false, version: false, bell: true, desktop: true, webhook: null, cooldown: 60,
    th: { ...DEFAULT_THRESHOLDS }, out: null,
  };
  const need = (i: number, flag: string, allowNeg = false) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && !(allowNeg && /^-\d/.test(v)))) throw new Error(`Falta el valor de ${flag}`);
    return v;
  };
  const numArg = (i: number, flag: string) => {
    const n = Number(need(i, flag, true));
    if (!Number.isFinite(n)) throw new Error(`Valor no numérico para ${flag}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    switch (x) {
      case 'dump': case 'report': case 'top': if (i === 0) { a.cmd = x; break; } a.paths.push(x); break;
      case '--host': a.host = need(i, x); i++; break;
      case '--user': a.user = need(i, x); i++; break;
      case '-i': case '--interval': a.interval = Math.max(2, numArg(i, x)); i++; break;
      case '--log-dir': a.logDir = need(i, x); a.logFile = null; i++; break;
      case '--log': a.logFile = need(i, x); i++; break;
      case '--no-log': a.logDir = null; a.logFile = null; break;
      case '--json': a.json = true; break;
      case '--force': a.force = true; break;
      case '--relogin': a.relogin = true; break; // por compatibilidad: ya es lo predeterminado
      case '--no-relogin': a.relogin = false; break;
      case '--demo': a.demo = true; break;
      case '--debug': a.debug = true; break;
      case '--allow-public': a.allowPublic = true; break;
      case '--alert-rx': a.th.rxLow = numArg(i, x); i++; break;
      case '--alert-jump': a.th.rxJump = Math.abs(numArg(i, x)); i++; break;
      case '--alert-temp': a.th.tempHigh = numArg(i, x); i++; break;
      case '--cooldown': a.cooldown = Math.max(0, numArg(i, x)); i++; break;
      case '--webhook': {
        const u = need(i, x); i++;
        let url: URL;
        try { url = new URL(u); } catch { throw new Error(`URL de webhook no válida: ${u}`); }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('El webhook debe ser http(s)');
        a.webhook = url.toString();
        break;
      }
      case '--no-notify': a.desktop = false; break;
      case '--no-bell': a.bell = false; break;
      case '--out': a.out = need(i, x); i++; break;
      case '-h': case '--help': a.help = true; break;
      case '-V': case '--version': a.version = true; break;
      case '--password': case '--pass': case '-p':
        throw new Error('Por seguridad la contraseña no se acepta como argumento: se pedirá por teclado');
      default:
        if (a.cmd === 'report' && !x.startsWith('-')) { a.paths.push(x); break; }
        throw new Error(`Opción desconocida: ${x}`);
    }
  }
  return a;
}

export function isLocalHost(base: string): boolean {
  const h = new URL(base).hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [o1, o2] = [Number(m[1]), Number(m[2])];
    return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  return /^(fe80:|fc|fd|::1$)/i.test(h);
}

interface Source {
  read(): Promise<PonSample>;
  /** Reconexión manual (tecla l) */
  relogin(): Promise<void>;
  close(): Promise<void>;
  model: string | null;
  devInfo: Obj | null;
  client?: RouterClient;
  keeper?: SessionKeeper;
  /** Recibe los avisos de la gestión de sesión */
  onNote: (n: SessionNote) => void;
}

async function connect(a: Args): Promise<Source> {
  const base = normalizeBase(a.host);
  const debugLog = a.debug ? (m: string) => appendFileSync('pon-top-debug.log', `${new Date().toISOString()} ${m}\n`, { mode: 0o600 }) : undefined;
  const client = new RouterClient({ host: base, debug: debugLog });

  if (!process.stdin.isTTY) throw new Error('Ejecuta pon-top en una terminal interactiva: necesita pedirte la contraseña');
  console.log(`Router: ${base}`);
  const user = a.user ?? ((await promptLine(`Usuario [${DEFAULT_USER}]: `)) || DEFAULT_USER);
  let password = await promptHidden('Contraseña: ');
  if (!password) throw new Error('Contraseña vacía');

  try {
    const busy = await client.getBusy();
    if (busy.isLogined && !a.force) {
      console.log('Hay otra sesión de administración abierta en el router (p. ej. tu navegador).');
      console.log('El router solo admite una: si continúas, esa sesión se cerrará.');
      if (!(await confirm('¿Continuar? [s/N] '))) throw new Error('Cancelado: no se ha iniciado sesión');
    }
  } catch (e) {
    if ((e as Error).message.startsWith('Cancelado')) throw e;
    // getBusy no es imprescindible
  }

  process.stdout.write('Iniciando sesión… ');
  await client.login(user, password);
  console.log('OK');

  const devInfo = await readDevInfo(client);
  const model = devInfo ? [devInfo['modelName'], devInfo['softwareVersion']].filter(Boolean).join(' · ') || null : null;

  const src: Source = {
    model,
    devInfo,
    read: () => keeper.run(() => readPon(client)),
    relogin: () => keeper.renew(true),
    close: async () => { await client.logout(); password = ''; },
    client,
    onNote: () => {},
  };
  const keeper = new SessionKeeper(client, () => client.login(user, password), {
    auto: a.relogin, force: a.force, onNote: n => src.onNote(n),
  });
  src.keeper = keeper;
  return src;
}

function demoSource(): Source {
  const read = createDemoSource();
  return { model: 'XGB430v Pro (demo)', devInfo: { modelName: 'XGB430v Pro (demo)' }, read, relogin: async () => {}, close: async () => {}, onNote: () => {} };
}

function notifyDesc(a: Args): string {
  const parts = [a.desktop ? 'escritorio' : null, a.bell ? 'pitido' : null, a.webhook ? 'webhook' : null].filter(Boolean);
  return parts.length ? parts.join('+') : 'solo en pantalla';
}

/** Une registro, avisos y seguimiento para ambos modos (interfaz y JSON) */
function wire(a: Args, src: Source, rec: Recorder, bell: () => void, onAlert: (e: MonEvent) => void) {
  const alerter = new Alerter({ bell: a.bell, desktop: a.desktop, webhook: a.webhook, cooldownSec: a.cooldown }, { bell });
  const tr = new Tracker({
    thresholds: a.th,
    onEvent: e => {
      rec.event(e);
      if (alerter.handle(e)) onAlert(e);
    },
  });
  rec.meta({
    version: FULL_VERSION, host: normalizeBase(a.host), interval: a.interval, thresholds: a.th,
    model: src.model, devInfo: src.devInfo, notify: notifyDesc(a),
  });
  rec.session('login', 'Sesión iniciada en el router');
  // (el evento ya queda en el registro a través del seguimiento)
  src.onNote = n => { tr.emit(n.kind === 'renewed' ? 'INFO' : 'SESION', n.msg); };
  return { tr, alerter };
}

async function runJson(src: Source, a: Args, rec: Recorder): Promise<void> {
  const { tr } = wire(a, src, rec, () => process.stderr.write('\x07'), e => process.stderr.write(`AVISO ${e.kind}: ${e.msg}\n`));
  let stop = false;
  const finish = () => { stop = true; };
  process.once('SIGINT', finish);
  process.once('SIGTERM', finish);
  while (!stop) {
    try {
      const s = await src.read();
      const ev = tr.push(s);
      rec.sample(s);
      const { raw: _raw, ...rest } = s;
      const r = (v: number | null, d = 2) => (v === null ? null : +v.toFixed(d));
      process.stdout.write(JSON.stringify({
        ...rest, t: isoLocal(s.t), rx: r(s.rx), tx: r(s.tx), temp: r(s.temp), bias: r(s.bias), cpu: r(s.cpu, 0), mem: r(s.mem, 1),
        ev: ev.map(e => `${e.kind}: ${e.msg}`),
      }) + '\n');
    } catch (e) {
      const msg = (e as Error).message;
      rec.error(msg);
      process.stderr.write(`error: ${msg}\n`);
      if (e instanceof RouterError && e.code === 'SESSION') {
        if (!a.relogin || src.keeper?.blocked) { tr.emit('SESION', msg); break; }
        // la propia gestión de sesión decide cuándo reintentar
      } else tr.error(msg);
    }
    for (let i = 0; i < a.interval * 10 && !stop; i++) await new Promise(r => setTimeout(r, 100));
  }
}

async function runTop(src: Source, a: Args, rec: Recorder): Promise<void> {
  const out = process.stdout;
  const screen = new Screen(out);
  const view: ViewState = {
    host: new URL(normalizeBase(a.host)).host, model: src.model, intervalSec: a.interval, paused: false,
    connected: true, busy: false, message: null, logPath: rec.path, startedAt: Date.now(),
    color: !process.env['NO_COLOR'], alert: null, muted: false, rawView: false, notifyDesc: notifyDesc(a),
  };
  const { tr, alerter } = wire(a, src, rec, () => out.write('\x07'), e => { view.alert = e; });
  let timer: NodeJS.Timeout | null = null;
  let clock: NodeJS.Timeout | null = null;
  let exiting = false;

  const draw = () => { if (!exiting) { view.logPath = rec.path; screen.draw(renderFrame(tr, view, out.columns || 100, out.rows || 40)); } };
  const schedule = (ms = view.intervalSec * 1000) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  async function tick(): Promise<void> {
    if (view.paused || !view.connected || view.busy) { schedule(); return; }
    view.busy = true; draw();
    try {
      const s = await src.read();
      tr.push(s);
      rec.sample(s);
      view.message = null;
    } catch (e) {
      const err = e as RouterError;
      if (err.code === 'SESSION') {
        // Sin sesión: la gestión de sesión ya ha avisado; se sigue intentando en cada lectura
        if (!a.relogin || src.keeper?.blocked) view.connected = false; // hace falta pulsar l
        view.message = !a.relogin ? 'El router ha cerrado la sesión: pulsa l para volver a entrar' : err.message;
        if (!a.relogin) tr.emit('SESION', 'El router ha cerrado la sesión');
      } else {
        rec.error(err.message);
        tr.error(err.message);
      }
    } finally {
      view.busy = false;
      draw();
      schedule();
    }
  }

  async function reconnect(): Promise<void> {
    view.message = 'Reconectando…'; draw();
    try {
      await src.relogin(); // las notas de sesión ya registran el resultado
      view.connected = true;
      view.message = null;
      schedule(100);
    } catch (e) {
      view.message = (e as Error).message;
    }
    draw();
  }

  async function quit(code = 0): Promise<never> {
    if (exiting) process.exit(code);
    exiting = true;
    if (timer) clearTimeout(timer);
    if (clock) clearInterval(clock);
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* */ }
    screen.leave();
    process.stdout.write('Cerrando sesión en el router… ');
    await Promise.race([src.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    rec.session('logout', 'Fin de la monitorización');
    rec.close();
    const st = tr.stats;
    const av = tr.time.total ? ((tr.time.o5 / tr.time.total) * 100).toFixed(2) + '%' : '--';
    console.log(`hecho.\nResumen: ${tr.samples.length} lecturas, disponibilidad ${av}, ${st.ponDrops} caídas PON, ${st.rxJumps} saltos de RX, ${st.reregs} posibles re-registros, ${st.reboots} reinicios, ${alerter.sent} avisos.`);
    if (rec.enabled) console.log(`Registro en ${rec.path} y ${rec.eventsPath}. Informe: pon-top report`);
    process.exit(code);
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k: string) => {
    if (k === 'q' || k === 'Q' || k === '\u0003' || k === '\u001b') void quit();
    else if (k === 'p' || k === ' ') { view.paused = !view.paused; rec.session(view.paused ? 'pausa' : 'reanudar', view.paused ? 'Monitorización en pausa' : 'Monitorización reanudada'); draw(); if (!view.paused) schedule(100); }
    else if (k === 'r') schedule(0);
    else if (k === '+') { view.intervalSec = Math.min(300, view.intervalSec + 1); draw(); }
    else if (k === '-') { view.intervalSec = Math.max(2, view.intervalSec - 1); draw(); }
    else if (k === 'v') { view.rawView = !view.rawView; draw(); }
    else if (k === 'm') { view.muted = alerter.muted = !alerter.muted; draw(); }
    else if (k === 'l') void reconnect();
  });
  process.on('SIGTERM', () => void quit());
  process.on('SIGHUP', () => void quit());
  out.on('resize', draw);
  process.on('uncaughtException', e => { screen.leave(); console.error(e); void quit(1); });

  screen.enter();
  draw();
  clock = setInterval(draw, 1000);
  schedule(0);
}

function runReport(a: Args): void {
  const paths = a.paths.length ? a.paths : defaultReportPaths();
  if (!paths.length) throw new Error('No encuentro registros: indica la carpeta o los ficheros pon-*.jsonl');
  const md = renderReport(analyze(loadRecords(paths), a.th));
  if (a.out) {
    writeFileSync(a.out, md + '\n');
    console.log(`Informe guardado en ${a.out}`);
  } else console.log(md);
}

async function main(): Promise<void> {
  let a: Args;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message + '\n\n' + HELP);
    process.exit(2);
  }
  if (a.help) { console.log(HELP); return; }
  if (a.version) { console.log(`pon-top ${FULL_VERSION}`); return; }

  if (a.cmd === 'report') {
    try { runReport(a); } catch (e) { console.error((e as Error).message); process.exit(1); }
    return;
  }

  const base = normalizeBase(a.host);
  if (!a.demo && !a.allowPublic && !isLocalHost(base)) {
    console.error(`${base} no parece una dirección de tu red local. Usa --allow-public si es intencionado.`);
    process.exit(2);
  }

  let src: Source;
  try {
    src = a.demo ? demoSource() : await connect(a);
  } catch (e) {
    const err = e as RouterError;
    console.error(`\n${err.message}`);
    if (a.debug && err.detail) console.error(JSON.stringify(err.detail).slice(0, 500));
    process.exit(1);
  }

  if (a.cmd === 'dump') {
    try {
      if (!src.client) throw new Error('dump no está disponible en modo demo');
      console.log(JSON.stringify(await dumpRaw(src.client), null, 2));
    } finally {
      await src.close();
    }
    return;
  }

  const rec = new Recorder({ dir: a.demo ? null : a.logDir, file: a.demo ? null : a.logFile });
  if (a.json || !process.stdout.isTTY) {
    try { await runJson(src, a, rec); } finally { rec.session('logout', 'Fin de la monitorización'); rec.close(); await src.close(); }
    return;
  }
  await runTop(src, a, rec);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
