import assert from 'node:assert/strict';
import { pickWan, readPon, type Obj } from '../src/pon.ts';
import { RouterClient, RouterError } from '../src/client.ts';
import { Tracker } from '../src/monitor.ts';
import type { PonSample } from '../src/pon.ts';

// Misma forma que la lista real del XGB430v Pro de Digi
const usb3g = { enable: '1', name: 'usb_ppp3g', connType: 'PPP3G', accessMode: 'USB', connStatusV4: 'Disconnected', connIPv4Address: '0.0.0.0', X_TP_Uptime: '0' };
const usb4g = { enable: '1', name: 'usb_dhcp4g', connType: 'DHCP4G', accessMode: 'USB', connStatusV4: 'Disconnected', connIPv4Address: '0.0.0.0', X_TP_Uptime: '0' };
const voip = { enable: '1', name: 'ipoe_gpon_2_0_s', connType: 'StaticIP', connStatusV4: 'Connected', connIPv4Address: '10.200.0.9', X_TP_Uptime: '824' };
const pppoe = { enable: '1', name: 'pppoe_gpon_20_1', connType: 'PPPoE', connStatusV4: 'Connected', connIPv4Address: '203.0.113.45', X_TP_Uptime: '820' };
const LIST: Obj[] = [usb3g, usb4g, voip, pppoe];

export async function testWan(): Promise<void> {
  // Sin saber la ruta por defecto: la PPPoE, nunca la del módem USB ni la de VoIP
  assert.equal(pickWan(LIST, null)?.name, 'pppoe_gpon_20_1');
  assert.equal(pickWan(LIST, 'pppoe_gpon_20_1')?.uptime, 820);
  // Con la PPPoE caída sigue siendo la PPPoE (se ve caída), no otra conexión
  const down = [usb3g, usb4g, voip, { ...pppoe, connStatusV4: 'Disconnected', connIPv4Address: '0.0.0.0' }];
  assert.equal(pickWan(down, null)?.status, 'Disconnected');
  assert.equal(pickWan(down, null)?.name, 'pppoe_gpon_20_1');
  // Si de verdad se usa un módem USB conectado y es la ruta por defecto, se respeta
  const usbOn = [{ ...usb4g, connStatusV4: 'Connected', connIPv4Address: '100.64.1.2' }, voip, pppoe];
  assert.equal(pickWan(usbOn, 'usb_dhcp4g')?.name, 'usb_dhcp4g');
  assert.equal(pickWan(usbOn, null)?.name, 'pppoe_gpon_20_1');
  // La misma conexión que la vez anterior si no hay más pistas
  assert.equal(pickWan([voip, { ...voip, name: 'otra' }], null, 'otra')?.name, 'otra');

  // Si la sesión se cierra a mitad de la lectura (aunque sea en una consulta secundaria), la lectura
  // entera falla con SESSION para que se renueve y se repita; un fallo normal no la invalida
  const data: Record<string, unknown> = {
    DEV2_OPTC_GPON_CFG: [{ ponType: 'XGSPON', MACAddress: '131', status: '5', RXPower: '171', TXPower: '39902', transceiverTemperature: '12150', supplyVottage: '3333', biasCurrent: '8940' }],
    DEV2_GPON_INTF_STATS: [{ bytesSent: '1', bytesReceived: '2', packetsSent: '3', packetsReceived: '4' }],
    DEV2_GPON_INTF_OMCI_STATS: [{ packetsSent: '5', packetsReceived: '6' }],
    DEV2_ADT_WAN: LIST,
  };
  let failOid: string | null = 'DEV2_ROUTER_V4FWD';
  let failCode = 'SESSION';
  const fake = new RouterClient({ host: '192.168.1.1' });
  (fake as unknown as { dm: unknown }).dm = async (_op: string, oid: string) => {
    if (oid === failOid) throw new RouterError('x', failCode);
    if (oid in data) return data[oid];
    throw new RouterError('no existe', 'DM');
  };
  await assert.rejects(readPon(fake), (e: RouterError) => e.code === 'SESSION');
  failCode = 'NET';
  const s = await readPon(fake);
  assert.equal(s.wan?.name, 'pppoe_gpon_20_1', 'sin ruta por defecto, la PPPoE');
  assert.equal(s.wan?.status, 'Connected');
  failOid = null;

  // Si cambia la conexión que se mira, no se compara el estado de dos conexiones distintas
  const base = (t: number, wan: PonSample['wan']): PonSample => ({
    t, ponType: 'XGSPON', onuId: '131', statusCode: 5, state: 'O5', rx: -17.8, rxRaw: 166, tx: 6, temp: 47.8, vcc: 3333, bias: 17.7,
    fecUs: true, fecDs: true, bytesUp: 1, bytesDown: 1, pktsUp: 1, pktsDown: t, omciUp: 1, omciDown: 1, uptime: 1000 + t, cpu: 3, mem: 62, wan,
  });
  const tr = new Tracker();
  tr.push(base(0, pickWan(LIST)));
  assert.equal(pickWan([usb3g]), null, 'un módem USB desconectado nunca se elige');
  assert.deepEqual(tr.push(base(5000, { ...pickWan(LIST)!, name: 'usb_ppp3g', type: 'PPP3G', status: 'Disconnected', ip: '0.0.0.0' })).map(e => e.kind), []);
  assert.equal(tr.stats.wanDrops, 0);
  console.log('wan OK');
}
