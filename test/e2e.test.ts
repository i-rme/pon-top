import assert from 'node:assert/strict';
import { startMockRouter } from './mock-router.ts';
import { RouterClient, RouterError } from '../src/client.ts';
import { readPon } from '../src/pon.ts';
import { Tracker } from '../src/monitor.ts';
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

export function testTracker(): void {
  const base: PonSample = {
    t: 0, ponType: 'XGSPON', onuId: '131', statusCode: 5, state: 'O5', rx: -17.67, rxRaw: 171, tx: 6, temp: 47, vcc: 3333, bias: 17.7,
    fecUs: true, fecDs: true, bytesUp: 100, bytesDown: 4294967000, pktsUp: 10, pktsDown: 1000, omciUp: 740, omciDown: 720,
    uptime: 1000, cpu: 10, mem: 40, wan: { name: 'w', type: 'PPPoE', status: 'Connected', ip: '1.2.3.4', gateway: '' },
  };
  const seen: string[] = [];
  const tr = new Tracker({ onEvent: e => seen.push(e.kind) });
  const at = (sec: number, patch: Partial<PonSample>): PonSample => ({ ...base, t: sec * 1000, uptime: 1000 + sec, pktsDown: 1000 + sec * 10, ...patch });
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
  assert.deepEqual(push(at(40, { rx: -27.45, omciDown: 728 })), ['PON_RECUPERADA', 'WAN_OK']);
  // vuelve el RX bueno: salto + RX normal (histéresis de 1 dB)
  assert.deepEqual(push(at(45, { rx: -17.67, omciDown: 728 })), ['SALTO_RX', 'RX_NORMAL']);
  // temperatura alta, sin repetir mientras siga alta
  assert.deepEqual(push(at(50, { temp: 75, omciDown: 728 })), ['TEMP_ALTA']);
  assert.deepEqual(push(at(55, { temp: 74, omciDown: 728 })), []);
  // re-registro silencioso (sin caída observada)
  assert.deepEqual(push(at(60, { omciDown: 740 })), ['POSIBLE_REREGISTRO']);
  // pérdida total de señal (DESC) y vuelta con otra potencia: el salto se detecta aunque en medio no hubiera RX
  assert.deepEqual(push(at(65, { state: 'DESC', statusCode: 0, rx: null, rxRaw: 0, tx: null, omciDown: 740 })), ['PON_CAIDA']);
  assert.match(msgs.at(-1)!, /O5 → DESC \(sin señal óptica\) \(RX previo -17\.67 dBm\)/);
  assert.deepEqual(push(at(70, { rx: -27.45, rxRaw: 18, omciDown: 740 })), ['PON_RECUPERADA', 'SALTO_RX', 'RX_BAJO']);
  assert.match(msgs.find(m => m.includes('tras un corte'))!, /RX -17\.67 → -27\.45 dBm \(-9\.8 dB\) tras un corte/);
  // reinicio del router
  assert.equal(kinds({ ...base, t: 75000, uptime: 30, pktsDown: 5, rx: -27.45, omciDown: 740 })[0], 'REINICIO_ROUTER');
  assert.deepEqual(tr.stats, { ponDrops: 2, rxJumps: 3, reboots: 1, reregs: 1, wanDrops: 1, errors: 0 });
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
  console.log('tracker OK');
}
