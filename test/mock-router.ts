// Router simulado que implementa el protocolo tal y como lo hace la web del XGB430v Pro,
// verificando firma RSA, hash, seq+longitud y cifrado AES de cada petición.
import { createServer, type Server } from 'node:http';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync } from 'node:crypto';

const modPow = (b: bigint, x: bigint, m: bigint) => { let r = 1n; b %= m; while (x > 0n) { if (x & 1n) r = r * b % m; b = b * b % m; x >>= 1n; } return r; };
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

export interface MockOptions { user: string; password: string; omciBurst?: boolean }

export async function startMockRouter(opts: MockOptions): Promise<{ port: number; server: Server; state: { loginOk: number; requests: string[] } }> {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  const jwk = privateKey.export({ format: 'jwk' }) as { n: string; e: string; d: string };
  const big = (s: string) => BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'));
  const n = big(jwk.n), d = big(jwk.d);
  const nn = n.toString(16).toUpperCase();
  const seq = 123456789;
  let session: { key: string; iv: string; hash: string; cookie: string; token: string } | null = null;
  const state = { loginOk: 0, requests: [] as string[] };
  let omci = 742;

  const rsaDecrypt = (hex: string) => {
    let out = '';
    for (let i = 0; i < hex.length; i += 128) {
      const m = modPow(BigInt('0x' + hex.slice(i, i + 128)), d, n);
      out += Buffer.from(m.toString(16).padStart(128, '0'), 'hex').toString('utf8').replace(/\0+$/, '');
    }
    return out;
  };
  const aesDec = (k: string, iv: string, b64: string) => { const c = createDecipheriv('aes-128-cbc', Buffer.from(k), Buffer.from(iv)); return Buffer.concat([c.update(Buffer.from(b64, 'base64')), c.final()]).toString('utf8'); };
  const aesEnc = (k: string, iv: string, s: string) => { const c = createCipheriv('aes-128-cbc', Buffer.from(k), Buffer.from(iv)); return Buffer.concat([c.update(s, 'utf8'), c.final()]).toString('base64'); };

  const data: Record<string, unknown> = {
    DEV2_OPTC_GPON_CFG: [{ ponType: 'XGSPON', MACAddress: '131', status: '5', fecUsEn: '1', fecDsEn: '1', transceiverTemperature: '12150', supplyVottage: '3333', biasCurrent: '8940', TXPower: '39902', RXPower: '171' }],
    DEV2_GPON_INTF_STATS: [{ bytesSent: '365149555', bytesReceived: '4294967000', packetsSent: '478389', packetsReceived: '817376' }],
    DEV2_GPON_INTF_OMCI_STATS: [{ packetsSent: '742', packetsReceived: '724' }],
    DEV2_DEV_INFO: { upTime: '86400', modelName: 'XGB430v Pro', softwareVersion: '0.2.0 3.2.1 v60c3.0' },
    DEV2_PROC_STATUS: { CPUUsage: '12' },
    DEV2_MEM_STATUS: { total: '1000', free: '600' },
    // Como en el router real: primero una WAN estática conectada (VoIP/gestión) y después la PPPoE de Internet
    DEV2_ADT_WAN: [
      { enable: '1', name: 'ipoe_0_2', connType: 'StaticIP', connStatusV4: 'Connected', connIPv4Address: '10.200.0.9', connIPv4Gateway: '10.200.0.1' },
      { enable: '1', name: 'pppoe_0_1', connType: 'PPPoE', connStatusV4: 'Connected', connIPv4Address: '203.0.113.45', connIPv4Gateway: '10.64.0.1' },
    ],
    DEV2_ROUTER_V4FWD: [
      { enable: '1', destIPAddress: '10.0.0.0', destSubnetMask: '255.0.0.0', X_TP_ConnName: 'ipoe_0_2' },
      { enable: '1', destIPAddress: '', destSubnetMask: '', X_TP_ConnName: 'pppoe_0_1' },
    ],
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = req.url ?? '';
      state.requests.push(`${req.method} ${url}`);
      if (req.headers['referer'] !== `http://127.0.0.1:${(server.address() as { port: number }).port}/`) { res.writeHead(403); res.end(); return; }
      const cookieOk = session && (req.headers['cookie'] ?? '').includes(`JSESSIONID=${session.cookie}`);

      if (url === '/cgi/getGDPRParm') { res.end(`var adminSetting=1;\nvar userSetting=1;\nvar logoUrl="";\nvar ee="010001";\nvar nn="${nn}";\nvar seq="${seq}";\n$.ret=0;\n`); return; }
      if (url === '/cgi/getBusy') { res.end(`var isLogined=${session ? 1 : 0};\nvar isBusy=0;\n$.ret=0;\n`); return; }
      if (url === '/' && req.method === 'GET') {
        res.end(cookieOk ? `<html><script type="text/javascript">var token="${session!.token}";</script></html>` : '<html>login</html>');
        return;
      }
      if (url === '/cgi_gdpr?9' && req.method === 'POST') {
        const m = body.match(/^sign=([0-9a-f]+)\r\ndata=([A-Za-z0-9+/=]+)\r\n$/);
        if (!m) { res.writeHead(400); res.end('bad body'); return; }
        const sign = rsaDecrypt(m[1]!);
        const dataB64 = m[2]!;
        if (sign.startsWith('key=')) {
          const p = Object.fromEntries(sign.split('&').map(kv => kv.split('=') as [string, string]));
          const plain = JSON.parse(aesDec(p['key']!, p['iv']!, dataB64));
          const okSeq = Number(p['s']) === seq + dataB64.length;
          const user = Buffer.from(plain.data.UserName, 'base64').toString();
          const pass = Buffer.from(plain.data.Passwd, 'base64').toString();
          const ok = okSeq && plain.oid === '/cgi/login' && plain.operation === 'cgi' && user === opts.user && pass === opts.password && p['h'] === md5(user + pass);
          if (ok) {
            session = { key: p['key']!, iv: p['iv']!, hash: p['h']!, cookie: 'c' + Date.now(), token: 'tok' + Date.now() };
            state.loginOk++;
            res.setHeader('Set-Cookie', `JSESSIONID=${session.cookie}; Path=/; HttpOnly`);
            res.end(aesEnc(p['key']!, p['iv']!, '$.ret=0;\n'));
          } else {
            res.end(aesEnc(p['key']!, p['iv']!, '$.ret=71233;\n'));
          }
          return;
        }
        if (!session || !cookieOk || req.headers['tokenid'] !== session.token) { res.writeHead(403); res.end(); return; }
        const p = Object.fromEntries(sign.split('&').map(kv => kv.split('=') as [string, string]));
        if (p['h'] !== session.hash || Number(p['s']) !== seq + dataB64.length) { res.writeHead(403); res.end('bad sign'); return; }
        const req2 = JSON.parse(aesDec(session.key, session.iv, dataB64).trim());
        const { key, iv } = session;
        if (req2.operation === 'cgi' && req2.oid === '/cgi/logout') { session = null; res.end(aesEnc(key, iv, '$.ret=0;\n')); return; }
        if (opts.omciBurst && req2.oid === 'DEV2_GPON_INTF_OMCI_STATS') { omci += 9; (data[req2.oid] as Record<string, string>[])[0]!['packetsReceived'] = String(omci); }
        const payload = data[req2.oid];
        if (payload === undefined) { res.end(aesEnc(key, iv, JSON.stringify({ success: false, errorcode: 9001 }))); return; }
        let out = payload;
        if (req2.operation === 'go' && !Array.isArray(payload)) {
          const wanted = Object.keys(req2.data).filter(k => k !== 'stack' && k !== 'pstack');
          if (wanted.length) out = Object.fromEntries(wanted.map(k => [k, (payload as Record<string, string>)[k]]));
        }
        res.end(aesEnc(key, iv, JSON.stringify({ success: true, errorcode: 0, data: out })));
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, server, state };
}
