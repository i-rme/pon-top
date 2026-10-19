import assert from 'node:assert/strict';
import { startMockRouter } from './mock-router.ts';
import { RouterClient, RouterError } from '../src/client.ts';
import { readPon } from '../src/pon.ts';
import { Tracker } from '../src/monitor.ts';
import { SessionKeeper, type SessionNote } from '../src/session.ts';
import type { PonSample } from '../src/pon.ts';

export async function testE2E(): Promise<void> {
  const mock = await startMockRouter({ user: 'admin', password: 'secreto' });
  const host = `127.0.0.1:${mock.port}`;
  try {
    const c = new RouterClient({ host });
    assert.deepEqual(await c.getBusy(), { isLogined: false, isBusy: false });

    // contraseña incorrecta -> error claro, sin sesión
    await assert.rejects(c.login('admin', 'mal'), (e: RouterError) => e.code === '71233' && /incorrectos/.test(e.message));
    assert.equal(c.loggedIn, false);

    await c.login('admin', 'secreto');
    assert.equal(c.loggedIn, true);
    assert.deepEqual(await c.getBusy(), { isLogined: true, isBusy: false });

    const s = await readPon(c);
    assert.equal(s.state, 'O5');
    assert.equal(s.onuId, '131');
    assert.equal(s.ponType, 'XGSPON');
    assert.equal(s.rx!.toFixed(2), '-17.67');
    assert.equal(s.tx!.toFixed(2), '6.01');
    assert.equal(s.temp!.toFixed(2), '47.85');
    assert.equal(s.bias!.toFixed(2), '17.88');
    assert.equal(s.vcc, 3333);
    assert.equal(s.fecUs, true);
    assert.equal(s.omciDown, 724);
    assert.equal(s.uptime, 86400);
    assert.equal(s.cpu, 12);
    assert.equal(s.mem, 40);
    assert.equal(s.wan?.status, 'Connected');
    assert.equal(s.wan?.type, 'PPPoE', 'la WAN de Internet es la de la ruta por defecto, no la estática');
    assert.equal(s.wan?.ip, '203.0.113.45');

    await c.logout();
    assert.equal(c.loggedIn, false);
    assert.deepEqual(await c.getBusy(), { isLogined: false, isBusy: false }, 'logout debe cerrar la sesión en el router');
    console.log(`e2e OK (${mock.state.requests.length} peticiones al router simulado)`);
  } finally {
    mock.server.close();
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Caducidad de la sesión (HTTP 406 + socket cerrado), renovación automática y casos en que no debe renovar */
export async function testSessionExpiry(): Promise<void> {
  const mock = await startMockRouter({ user: 'user', password: 'secreto', sessionTtlMs: 300 });
  try {
    const c = new RouterClient({ host: `127.0.0.1:${mock.port}` });
    let pass = 'secreto';
    const notes: SessionNote[] = [];
    let clock = 0;
    const k = new SessionKeeper(c, () => c.login('user', pass), { auto: true, force: false, onNote: n => notes.push(n), now: () => clock });
    await c.login('user', 'secreto');
    assert.equal((await k.run(() => readPon(c))).state, 'O5');

    // 1) caduca: 406 -> se renueva sola y la lectura no se pierde; las siguientes peticiones no fallan por el socket cerrado
    await sleep(350);
    for (let i = 0; i < 3; i++) assert.equal((await k.run(() => readPon(c))).state, 'O5');
    assert.equal(mock.state.expired, 1);
    assert.equal(mock.state.loginOk, 2);
    assert.deepEqual(notes.map(n => n.kind), ['renewed']);

    // 2) sin renovación automática, el 406 se notifica como sesión perdida (no como error de lectura)
    await sleep(350);
    const manual = new SessionKeeper(c, () => c.login('user', pass), { auto: false, force: false });
    await assert.rejects(manual.run(() => readPon(c)), (e: RouterError) => e.code === 'SESSION' && /406/.test(e.message));

    // 3) alguien ha entrado en la web: no se le echa, se avisa una vez y se reintenta al minuto
    mock.state.otherSession = true;
    await assert.rejects(k.run(() => readPon(c)), /otra sesión abierta/);
    await assert.rejects(k.run(() => readPon(c)), /nuevo intento en 60 s/);
    assert.equal(notes.filter(n => n.kind === 'waiting').length, 1);
    assert.equal(mock.state.loginOk, 2, 'no ha cerrado la otra sesión');
    clock += 61_000;
    await assert.rejects(k.run(() => readPon(c)), /otra sesión abierta/);
    assert.equal(notes.filter(n => n.kind === 'waiting').length, 1, 'no repite el aviso cada minuto');
    // tecla l: entra igualmente
    await k.renew(true);
    assert.equal(mock.state.loginOk, 3);
    assert.equal((await k.run(() => readPon(c))).state, 'O5');

    // 4) contraseña cambiada: un solo intento y se bloquea (sin martillear el router)
    pass = 'otra';
    await sleep(350);
    await assert.rejects(k.run(() => readPon(c)), /rechazado el inicio de sesión/);
    await assert.rejects(k.run(() => readPon(c)), /rechazado/);
    clock += 3_600_000;
    await assert.rejects(k.run(() => readPon(c)), /rechazado/);
    assert.equal(mock.state.loginFail, 1, 'un único intento fallido');
    assert.ok(k.blocked);
    console.log(`sesión OK (${mock.state.expired} caducidades, ${mock.state.loginOk} logins)`);
  } finally {
    mock.server.close();
  }
}

export function testTracker(): void {
  const base: PonSample = {
    t: 0, ponType: 'XGSPON', onuId: '131', statusCode: 5, state: 'O5', rx: -17.67, rxRaw: 171, tx: 6, temp: 47, vcc: 3333, bias: 17.7,
    fecUs: true, fecDs: true, bytesUp: 100, bytesDown: 4294967000, pktsUp: 10, pktsDown: 1000, omciUp: 740, omciDown: 720,
    uptime: 1000, cpu: 10, mem: 40, wan: { name: 'w', type: 'PPPoE', status: 'Connected', ip: '1.2.3.4', gateway: '', uptime: 500 },
  };
  const seen: string[] = [];
  const tr = new Tracker({ onEvent: e => seen.push(e.kind) });
  const wan = (sec: number, extra: Partial<NonNullable<PonSample['wan']>> = {}) => ({ ...base.wan!, uptime: 500 + sec, ...extra });
  const at = (sec: number, patch: Partial<PonSample>): PonSample => ({ ...base, t: sec * 1000, uptime: 1000 + sec, pktsDown: 1000 + sec * 10, wan: wan(sec), ...patch });
  const kinds = (s: PonSample) => tr.push(s).map(e => e.kind);
  const msgs: string[] = [];
  const push = (s: PonSample) => { const ev = tr.push(s); msgs.push(...ev.map(e => e.msg)); return ev.map(e => e.kind); };
  assert.deepEqual(push(at(0, {})), []);
  // contador de bytes de 32 bits que da la vuelta: 4294967000 -> 704 = +1000 bytes en 5 s
  assert.deepEqual(push(at(5, { bytesDown: 704 })), []);
  assert.equal(tr.rates.downBps, 1000 * 8 / 5);
  // salto de RX hacia abajo: salto + RX bajo (umbral -26)
  assert.deepEqual(push(at(10, { rx: -27.45, rxRaw: 18 })), ['SALTO_RX', 'RX_BAJO']);
  // caída (O2) y recuperación; la ráfaga OMCI de la recuperación no cuenta como re-registro aparte
  assert.deepEqual(push(at(15, { state: 'O2', statusCode: 2, tx: null, onuId: '255', rx: -27.45, wan: { ...base.wan!, status: 'Disconnected' } })), ['PON_CAIDA', 'WAN_CAIDA']);
  // Disconnected → Connecting sigue siendo la misma caída
  assert.deepEqual(push(at(38, { state: 'O2', statusCode: 2, tx: null, onuId: '255', rx: -27.45, wan: wan(38, { status: 'Connecting' }) })), []);
  assert.deepEqual(push(at(40, { rx: -27.45, omciDown: 728 })), ['PON_RECUPERADA', 'WAN_OK']);
  // la OLT termina de configurar la ONU justo después: no es una ráfaga aparte
  assert.deepEqual(push(at(42, { rx: -27.45, omciDown: 740 })), []);
  // vuelve el RX bueno: salto + RX normal (histéresis de 1 dB)
  assert.deepEqual(push(at(45, { rx: -17.67, omciDown: 740 })), ['SALTO_RX', 'RX_NORMAL']);
  // temperatura alta, sin repetir mientras siga alta
  assert.deepEqual(push(at(50, { temp: 75, omciDown: 740 })), ['TEMP_ALTA']);
  assert.deepEqual(push(at(55, { temp: 74, omciDown: 740 })), []);
  assert.deepEqual(push(at(60, { omciDown: 740 })), []);
  // pérdida total de señal (DESC) y vuelta con otra potencia: el salto se detecta aunque en medio no hubiera RX
  assert.deepEqual(push(at(65, { state: 'DESC', statusCode: 0, rx: null, rxRaw: 0, tx: null, omciDown: 740 })), ['PON_CAIDA']);
  assert.match(msgs.at(-1)!, /O5 → DESC \(sin señal óptica\) \(RX previo -17\.67 dBm\)/);
  assert.deepEqual(push(at(70, { rx: -27.45, rxRaw: 18, omciDown: 740 })), ['PON_RECUPERADA', 'SALTO_RX', 'RX_BAJO']);
  assert.match(msgs.find(m => m.includes('tras un corte'))!, /RX -17\.67 → -27\.45 dBm \(-9\.8 dB\) tras un corte/);
  // reinicio del router (el uptime del PPPoE también empieza de cero, pero no es una reconexión aparte)
  assert.deepEqual(kinds({ ...base, t: 75000, uptime: 30, pktsDown: 5, rx: -27.45, omciDown: 752, wan: wan(0, { uptime: 1 }) }), ['REINICIO_ROUTER']);
  assert.deepEqual(tr.stats, { ponDrops: 2, rxJumps: 3, reboots: 1, reregs: 0, wanDrops: 1, errors: 0, omciBursts: 0, wanReconnects: 0 });
  // tiempos: caídas 15→40 y 65→70; RX bajo en 10→45 y 70→75
  assert.equal(tr.time.total, 75);
  assert.equal(tr.time.down, 30);
  assert.equal(tr.time.o5, 45);
  assert.equal(tr.time.rxLow, 40);
  assert.equal(tr.topLevels(1)[0]?.rx, '-27.45');
  // errores seguidos -> SIN_DATOS al tercero, y aviso de vuelta
  tr.error('No se puede conectar: timeout'); tr.error('No se puede conectar: timeout'); tr.error('No se puede conectar: timeout');
  assert.equal(seen.filter(k => k === 'SIN_DATOS').length, 1);
  assert.equal(kinds({ ...base, t: 80000, uptime: 35, pktsDown: 6, rx: -27.45 })[0], 'INFO');
  // pantalla: repeticiones agrupadas con contador; el registro recibe cada ocurrencia
  const errs = tr.events.filter(e => e.kind === 'ERROR_LECTURA');
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.count, 3);
  assert.deepEqual(tr.events.filter(e => e.kind === 'SALTO_RX').map(e => e.count), [2, 1], 'saltos normales agrupados; el de tras un corte aparte');
  assert.equal(tr.events.filter(e => e.kind === 'PON_CAIDA').length, 2, 'O2 y DESC son caídas distintas');
  assert.equal(seen.filter(k => k === 'ERROR_LECTURA').length, 3);
  assert.equal(tr.events.at(-1)!.kind, 'INFO', 'lo último arriba');

  // Ráfagas OMCI y reconexiones del PPPoE con la línea estable (sin caídas recientes)
  const t2 = new Tracker();
  const m2: string[] = [];
  const p2 = (s: PonSample) => { const ev = t2.push(s); m2.push(...ev.map(e => e.msg)); return ev.map(e => e.kind); };
  assert.deepEqual(p2(at(0, {})), []);
  // ráfaga sin ningún indicio de corte: consulta de la OLT, no re-registro
  assert.deepEqual(p2(at(5, { omciUp: 758, omciDown: 738 })), ['RAFAGA_OMCI']);
  assert.match(m2.at(-1)!, /OMCI \+18\/\+18 en 5s sin corte/);
  // PPPoE reconectado entre dos lecturas (su uptime vuelve a empezar), sin ráfaga
  assert.deepEqual(p2(at(10, { omciUp: 758, omciDown: 738, wan: wan(10, { uptime: 2 }) })), ['WAN_RECONEXION']);
  assert.match(m2.at(-1)!, /PPPoE reconectado entre dos lecturas \(llevaba 8m 25s, ahora 2s\)/);
  // ráfaga + reconexión del PPPoE: posible re-registro corto
  assert.deepEqual(p2(at(15, { omciUp: 770, omciDown: 750, wan: wan(15, { uptime: 1 }) })), ['WAN_RECONEXION', 'POSIBLE_REREGISTRO']);
  assert.match(m2.at(-1)!, /OMCI \+12\/\+12 en 5s; el PPPoE se ha reconectado/);
  // ráfaga con cambio de ONU ID
  assert.deepEqual(p2(at(20, { omciUp: 782, omciDown: 762, onuId: '132', wan: wan(20, { uptime: 6 }) })), ['POSIBLE_REREGISTRO']);
  assert.deepEqual(t2.stats, { ponDrops: 0, rxJumps: 0, reboots: 0, reregs: 2, wanDrops: 0, errors: 0, omciBursts: 1, wanReconnects: 2 });
  console.log('tracker OK');
}
