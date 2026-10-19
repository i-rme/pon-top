import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import CryptoJS from 'crypto-js';
import { TpEncryptor, md5Hex } from '../src/crypto.ts';

export function testCrypto(): void {
  // 1) AES: igual que CryptoJS.AES.encrypt(texto, Utf8(key), {iv: Utf8(iv), CBC, Pkcs7}).toString()
  const enc = new TpEncryptor();
  enc.setAesKey('1729000000000123', '1729000000000456');
  const plain = '{"data":{"UserName":"YWRtaW4=","Passwd":"cGFzcw==","Action":"1"},"operation":"cgi","oid":"/cgi/login"}';
  const ours = enc.aesEncrypt(plain);
  const ref = CryptoJS.AES.encrypt(plain, CryptoJS.enc.Utf8.parse('1729000000000123'), {
    iv: CryptoJS.enc.Utf8.parse('1729000000000456'), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
  }).toString();
  assert.equal(ours, ref, 'AES distinto de CryptoJS');
  assert.equal(enc.aesDecrypt(ref), plain);
  const refDec = CryptoJS.AES.decrypt(ours, CryptoJS.enc.Utf8.parse('1729000000000123'), {
    iv: CryptoJS.enc.Utf8.parse('1729000000000456'), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7,
  }).toString(CryptoJS.enc.Utf8);
  assert.equal(refDec, plain);

  // 2) MD5 igual que CryptoJS.MD5(...).toString()
  assert.equal(md5Hex('adminpässword'), CryptoJS.MD5('adminpässword').toString());

  // 3) RSA nopadding: descifrar con la clave privada debe devolver texto + ceros a la derecha
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  const jwk = privateKey.export({ format: 'jwk' }) as { n: string; e: string; d: string };
  const b64uToBig = (s: string) => BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'));
  const n = b64uToBig(jwk.n), e = b64uToBig(jwk.e), d = b64uToBig(jwk.d);
  enc.setRsaKey(n.toString(16), e.toString(16));
  enc.setSeq(123456789);
  enc.setHash('admin', 'secreto');
  const sign = enc.signature(44, true);
  // texto de login = key=..&iv=..&h=<32>&s=<n> -> > 64 caracteres -> 2 bloques
  assert.equal(sign.length, 256, 'firma de login debe tener 2 bloques de 128 hex');
  const modPow = (b: bigint, x: bigint, m: bigint) => { let r = 1n; b %= m; while (x > 0n) { if (x & 1n) r = r * b % m; b = b * b % m; x >>= 1n; } return r; };
  const decBlock = (hex: string) => {
    const m = modPow(BigInt('0x' + hex), d, n);
    const buf = Buffer.from(m.toString(16).padStart(128, '0'), 'hex');
    return buf.toString('utf8').replace(/\0+$/, '');
  };
  const recovered = decBlock(sign.slice(0, 128)) + decBlock(sign.slice(128));
  assert.equal(recovered, `key=1729000000000123&iv=1729000000000456&h=${md5Hex('adminsecreto')}&s=${123456789 + 44}`);
  const s2 = enc.signature(100, false);
  assert.equal(s2.length, 128);
  assert.equal(decBlock(s2), `h=${md5Hex('adminsecreto')}&s=${123456789 + 100}`);
  console.log('crypto OK');
}
