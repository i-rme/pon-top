// Réplica del cifrado de la web del router (js/tpEncrypt.js + js/encrypt.js):
//  - AES-128-CBC/PKCS7 con clave e IV de 16 caracteres (UTF-8), salida en base64 (CryptoJS)
//  - Firma: RSA "sin padding" (bytes del texto + ceros a la derecha) en bloques de 64 caracteres,
//    cada bloque en hex de 128 caracteres
//  - hash = MD5(usuario + contraseña)
import { createCipheriv, createDecipheriv, createHash, randomInt } from 'node:crypto';
const RSA_BITS = 512; // el JS del router lo fija a 512
const CHUNK_CHARS = RSA_BITS / 8; // 64
const HEX_LEN = RSA_BITS / 4; // 128
export function md5Hex(text) {
    return createHash('md5').update(text, 'utf8').digest('hex');
}
function randomDigits(n) {
    let s = '';
    for (let i = 0; i < n; i++)
        s += String(randomInt(0, 10));
    return s;
}
function bytesToBigInt(bytes) {
    let x = 0n;
    for (const b of bytes)
        x = (x << 8n) | BigInt(b);
    return x;
}
function modPow(base, exp, mod) {
    let result = 1n;
    base %= mod;
    while (exp > 0n) {
        if (exp & 1n)
            result = (result * base) % mod;
        base = (base * base) % mod;
        exp >>= 1n;
    }
    return result;
}
export class TpEncryptor {
    aesKey = '';
    aesIv = '';
    n = 0n;
    e = 0n;
    nBytes = 0;
    seq = 0;
    hash = '';
    setRsaKey(nnHex, eeHex) {
        this.n = BigInt('0x' + nnHex);
        this.e = BigInt('0x' + eeHex);
        this.nBytes = Math.ceil(this.n.toString(2).length / 8);
    }
    setSeq(seq) {
        this.seq = seq;
    }
    setHash(user, password) {
        this.hash = md5Hex(user + password);
    }
    genAesKey() {
        this.aesKey = randomDigits(16);
        this.aesIv = randomDigits(16);
    }
    /** Para pruebas: fijar clave/IV conocidos */
    setAesKey(key, iv) {
        if (key.length !== 16 || iv.length !== 16)
            throw new Error('clave/IV deben tener 16 caracteres');
        this.aesKey = key;
        this.aesIv = iv;
    }
    get aesKeyString() {
        return `key=${this.aesKey}&iv=${this.aesIv}`;
    }
    aesEncrypt(plain) {
        const c = createCipheriv('aes-128-cbc', Buffer.from(this.aesKey, 'utf8'), Buffer.from(this.aesIv, 'utf8'));
        return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('base64');
    }
    aesDecrypt(b64) {
        const d = createDecipheriv('aes-128-cbc', Buffer.from(this.aesKey, 'utf8'), Buffer.from(this.aesIv, 'utf8'));
        return Buffer.concat([d.update(Buffer.from(b64.trim(), 'base64')), d.final()]).toString('utf8');
    }
    /** RSA "nopadding" del router: bytes UTF-8 del bloque + ceros a la derecha hasta el tamaño del módulo */
    rsaEncryptBlock(text) {
        const msg = Buffer.from(text, 'utf8');
        if (msg.length > this.nBytes)
            throw new Error('bloque demasiado largo para RSA');
        const padded = Buffer.alloc(this.nBytes);
        msg.copy(padded, 0);
        const c = modPow(bytesToBigInt(padded), this.e, this.n);
        return c.toString(16).padStart(HEX_LEN, '0');
    }
    rsaEncrypt(text) {
        let out = '';
        for (let i = 0; i < text.length; i += CHUNK_CHARS)
            out += this.rsaEncryptBlock(text.substring(i, i + CHUNK_CHARS));
        return out;
    }
    signature(dataLen, isLogin) {
        const s = this.seq + dataLen;
        const text = isLogin ? `${this.aesKeyString}&h=${this.hash}&s=${s}` : `h=${this.hash}&s=${s}`;
        return this.rsaEncrypt(text);
    }
    /** Cuerpo listo para POST a /cgi_gdpr */
    encryptBody(plain, isLogin) {
        const data = this.aesEncrypt(plain);
        const sign = this.signature(data.length, isLogin);
        return `sign=${sign}\r\ndata=${data}\r\n`;
    }
    /** Borra material sensible de memoria (en lo posible en JS) */
    wipe() {
        this.hash = '';
        this.aesKey = '';
        this.aesIv = '';
    }
}
