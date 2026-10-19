// Fuente simulada para probar la interfaz sin router (--demo)
import type { PonSample } from './pon.js';

export function createDemoSource() {
  const t0 = Date.now();
  let bytesDown = 4_200_000_000, bytesUp = 360_000_000, pktsDown = 820_000, pktsUp = 480_000;
  let omciUp = 740, omciDown = 720, uptime = 3600 * 5;
  let lastState = 'O5';
  let wanUp = 4000;

  return async function read(): Promise<PonSample> {
    const el = (Date.now() - t0) / 1000;
    uptime += 5;
    // Ciclo de 3 min: 90 s bien (-17,6), luego enlace al límite (-27,3) con un corte de ~25 s
    const phase = el % 180;
    const weak = phase >= 90;
    const down = phase >= 130 && phase < 155;
    const rxRaw = weak ? 18 + Math.round(Math.random()) : 171 + Math.round(Math.random());
    const state = down ? 'O2' : 'O5';
    if (state === 'O5' && lastState !== 'O5') { omciUp += 9; omciDown += 8; wanUp = 0; }
    lastState = state;
    if (!down) {
      bytesDown = (bytesDown + Math.round(2e6 + Math.random() * 6e6)) % 2 ** 32;
      bytesUp = (bytesUp + Math.round(2e5 + Math.random() * 5e5)) % 2 ** 32;
      pktsDown += 300 + Math.round(Math.random() * 200);
      pktsUp += 200 + Math.round(Math.random() * 100);
      if (Math.random() < 0.08) { omciUp += 3; omciDown += 2; }
    }
    const rx = 10 * Math.log10(rxRaw / 10000);
    return {
      t: Date.now(),
      ponType: 'XGSPON',
      onuId: down ? '255' : '131',
      statusCode: down ? 2 : 5,
      state,
      rx,
      rxRaw,
      tx: down ? null : 6 + (Math.random() - 0.5) * 0.1,
      temp: 47.6 + Math.random() * 0.2,
      vcc: 3333,
      bias: 17.7 + (Math.random() - 0.5) * 0.2,
      fecUs: true,
      fecDs: true,
      bytesUp, bytesDown, pktsUp, pktsDown, omciUp, omciDown,
      uptime,
      cpu: 8 + Math.random() * 10,
      mem: 41,
      wan: { name: 'pppoe', type: 'PPPoE', status: down ? 'Disconnected' : 'Connected', ip: down ? '0.0.0.0' : '192.0.2.10', gateway: '10.64.0.1', uptime: down ? 0 : (wanUp += 5) },
      raw: {
        optc: { ponType: 'XGSPON', MACAddress: down ? '255' : '131', status: down ? '2' : '5', fecUsEn: '1', fecDsEn: '1', RXPower: String(rxRaw), TXPower: down ? '0' : '39902', transceiverTemperature: '12150', supplyVottage: '3333', biasCurrent: '8850' },
        stats: { bytesSent: String(bytesUp), bytesReceived: String(bytesDown), packetsSent: String(pktsUp), packetsReceived: String(pktsDown) },
        omci: { packetsSent: String(omciUp), packetsReceived: String(omciDown) },
        wan: null,
      },
    };
  };
}
