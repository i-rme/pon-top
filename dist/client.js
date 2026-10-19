// Cliente de la API web del TP-Link XGB430v Pro (firmware Digi).
// Replica lo que hace la propia web: /cgi/getGDPRParm -> login cifrado -> token -> peticiones /cgi_gdpr
import { TpEncryptor } from './crypto.js';
export class RouterError extends Error {
    code;
    detail;
    constructor(message, code, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'RouterError';
    }
}
const ZERO_STACK = '0,0,0,0,0,0';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
export function normalizeBase(host) {
    let h = host.trim();
    if (!/^https?:\/\//i.test(h))
        h = 'http://' + h;
    return h.replace(/\/+$/, '');
}
export class RouterClient {
    base;
    enc = new TpEncryptor();
    cookies = new Map();
    token = null;
    timeoutMs;
    log;
    loggedIn = false;
    constructor(opts) {
        this.base = normalizeBase(opts.host);
        this.timeoutMs = opts.timeoutMs ?? 8000;
        this.log = opts.debug ?? (() => { });
    }
    async http(path, body) {
        const headers = {
            Referer: this.base + '/',
            Accept: '*/*',
        };
        if (body !== undefined)
            headers['Content-Type'] = 'text/plain';
        if (this.cookies.size)
            headers['Cookie'] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        if (this.token)
            headers['TokenID'] = this.token;
        let res;
        try {
            res = await fetch(this.base + path, {
                method: body !== undefined ? 'POST' : 'GET',
                headers,
                body,
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        }
        catch (e) {
            throw new RouterError(`No se puede conectar con ${this.base}${path}: ${e.message}`, 'NET');
        }
        for (const c of res.headers.getSetCookie()) {
            const kv = c.split(';')[0] ?? '';
            const i = kv.indexOf('=');
            if (i > 0)
                this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
        }
        const text = await res.text();
        this.log(`${body !== undefined ? 'POST' : 'GET'} ${path} -> ${res.status} (${text.length} B)`);
        return { status: res.status, text };
    }
    static parseJsVars(text) {
        const out = {};
        for (const m of text.matchAll(/var\s+(\w+)\s*=\s*"?([^";\r\n]*)"?\s*;/g))
            out[m[1]] = m[2];
        const ret = text.match(/\$\.ret\s*=\s*(-?\d+)/);
        if (ret)
            out['$ret'] = ret[1];
        return out;
    }
    /** ¿Hay otra sesión de administración abierta? (no requiere login) */
    async getBusy() {
        const r = await this.http('/cgi/getBusy', '');
        const v = RouterClient.parseJsVars(r.text);
        return { isLogined: v['isLogined'] === '1', isBusy: v['isBusy'] === '1' };
    }
    tryDecrypt(text) {
        const t = text.trim();
        if (!t || !/^[A-Za-z0-9+/=\r\n]+$/.test(t))
            return text;
        try {
            return this.enc.aesDecrypt(t);
        }
        catch {
            return text;
        }
    }
    async login(user, password) {
        const p = await this.http('/cgi/getGDPRParm', '');
        const v = RouterClient.parseJsVars(p.text);
        if (!v['nn'] || !v['ee'] || !v['seq'])
            throw new RouterError('Respuesta inesperada de /cgi/getGDPRParm', 'PARM', p.text.slice(0, 200));
        this.cookies.clear();
        this.token = null;
        this.enc.setRsaKey(v['nn'], v['ee']);
        this.enc.setSeq(parseInt(v['seq'], 10));
        this.enc.setHash(user, password);
        this.enc.genAesKey();
        const payload = JSON.stringify({
            data: { UserName: b64(user), Passwd: b64(password), Action: '1', stack: ZERO_STACK, pstack: ZERO_STACK },
            operation: 'cgi',
            oid: '/cgi/login',
        });
        const r = await this.http('/cgi_gdpr?9', this.enc.encryptBody(payload, true));
        const text = this.tryDecrypt(r.text).trim();
        this.log(`login <- ${redact(text)}`);
        let ok = false;
        let detail = text.slice(0, 300);
        try {
            const j = JSON.parse(text);
            ok = j.success === true;
            detail = j;
            if (!ok)
                throw new RouterError(loginErrorMessage(j), j.errorcode ?? 'LOGIN', j);
        }
        catch (e) {
            if (e instanceof RouterError)
                throw e;
            // Respuesta no JSON: la operación "cgi" devuelve JavaScript "$.ret=N;"
            const ret = RouterClient.parseJsVars(text)['$ret'];
            ok = ret === '0';
            if (ret !== undefined && !ok)
                throw new RouterError(loginErrorMessage({ errorcode: ret }), ret, text.slice(0, 300));
        }
        if (!ok)
            throw new RouterError(`Login rechazado (HTTP ${r.status})`, 'LOGIN', detail);
        // La web recarga "/" tras el login: ahí viene el token de sesión
        const home = await this.http('/');
        const tok = home.text.match(/var\s+token\s*=\s*"([^"]+)"/)?.[1] ??
            home.text.match(/tokenid\s*[:=]\s*"([^"]+)"/i)?.[1] ??
            null;
        if (!tok) {
            // Para diagnosticar con --debug: contexto de cada aparición de "token" (valores largos ocultos)
            const ctx = [...home.text.matchAll(/token/gi)].slice(0, 5).map(m => home.text.slice(Math.max(0, m.index - 60), m.index + 60).replace(/[0-9a-f]{12,}/gi, '<hex>'));
            this.log(`token no encontrado; HTTP ${home.status}, ${home.text.length} B; contexto: ${JSON.stringify(ctx)}`);
            throw new RouterError('Login aceptado pero no encuentro el token de sesión en la página principal', 'TOKEN', ctx);
        }
        this.token = tok;
        this.loggedIn = true;
    }
    /** API JSON de la web nueva ($.dm): operation go (objeto), gl (lista), cgi... */
    async dm(operation, oid, data = {}) {
        this.ensureLogin();
        const payload = JSON.stringify({ data: { stack: ZERO_STACK, pstack: ZERO_STACK, ...data }, operation, oid }) + '\r\n';
        const r = await this.http('/cgi_gdpr?9', this.enc.encryptBody(payload, false));
        this.checkHttp(r.status);
        const text = this.tryDecrypt(r.text).trim();
        let j;
        try {
            j = JSON.parse(text);
        }
        catch {
            throw new RouterError(`Respuesta no válida para ${oid} (¿sesión caducada?)`, 'SESSION', text.slice(0, 200));
        }
        if (j.success !== true)
            throw new RouterError(`El router devolvió error ${j.errorcode ?? '?'} para ${oid}`, j.errorcode ?? 'DM', j);
        return j.data;
    }
    /** API clásica ($.act/$.exe): varias peticiones en una */
    async act(reqs) {
        this.ensureLogin();
        let plain = reqs.map(r => r.type).join('&') + '\r\n';
        reqs.forEach((r, i) => {
            const attrs = r.attrs ?? [];
            plain += `[${r.oid}#${r.stack ?? ZERO_STACK}#${r.pstack ?? ZERO_STACK}]${i},${attrs.length}\r\n` + attrs.map(a => a + '\r\n').join('');
        });
        const resp = await this.http('/cgi_gdpr', this.enc.encryptBody(plain, false));
        this.checkHttp(resp.status);
        const text = this.tryDecrypt(resp.text);
        const out = reqs.map(r => (r.type === 5 || r.type === 6 ? [] : null));
        let cur = null;
        let sawHeader = false;
        for (const line of text.split(/\r?\n/)) {
            if (!line)
                continue;
            if (line.startsWith('[')) {
                sawHeader = true;
                const n = line.indexOf(']');
                const stack = line.slice(1, n);
                const idx = parseInt(line.slice(n + 1), 10);
                if (stack === 'error') {
                    if (idx)
                        throw new RouterError(`El router devolvió error ${idx}`, idx, text.slice(0, 300));
                    cur = null;
                    continue;
                }
                if (stack === 'cgi') {
                    cur = null;
                    continue;
                }
                cur = { __stack: stack };
                const slot = out[idx];
                if (Array.isArray(slot))
                    slot.push(cur);
                else
                    out[idx] = cur;
            }
            else if (cur) {
                const i = line.indexOf('=');
                if (i > 0)
                    cur[line.slice(0, i)] = line.slice(i + 1);
            }
        }
        if (!sawHeader)
            throw new RouterError('Respuesta no válida (¿sesión caducada?)', 'SESSION', text.slice(0, 200));
        return out;
    }
    /** Operaciones "cgi" ($.dm.cgi): la respuesta es JavaScript del tipo "$.ret=0;" */
    async cgi(oid, data = {}) {
        this.ensureLogin();
        const payload = JSON.stringify({ data: { stack: ZERO_STACK, pstack: ZERO_STACK, ...data }, operation: 'cgi', oid }) + '\r\n';
        const r = await this.http('/cgi_gdpr?9', this.enc.encryptBody(payload, false));
        this.checkHttp(r.status);
        const ret = RouterClient.parseJsVars(this.tryDecrypt(r.text))['$ret'];
        return ret === undefined ? -1 : parseInt(ret, 10);
    }
    async logout() {
        if (!this.loggedIn)
            return;
        try {
            await this.cgi('/cgi/logout');
        }
        catch {
            try {
                await this.act([{ type: 8, oid: '/cgi/logout' }]);
            }
            catch { /* sin importancia */ }
        }
        this.loggedIn = false;
        this.token = null;
        this.cookies.clear();
        this.enc.wipe();
    }
    ensureLogin() {
        if (!this.loggedIn)
            throw new RouterError('No hay sesión iniciada', 'SESSION');
    }
    checkHttp(status) {
        if (status === 401 || status === 403)
            throw new RouterError(`Sesión rechazada por el router (HTTP ${status})`, 'SESSION');
        if (status >= 400)
            throw new RouterError(`HTTP ${status}`, 'HTTP');
    }
}
function loginErrorMessage(j) {
    const d = (j.data ?? {});
    const left = d['attemptsAllowed'] ?? d['remainAttempts'];
    const extra = left !== undefined ? ` (intentos restantes: ${left})` : '';
    return `Login rechazado: usuario o contraseña incorrectos o cuenta bloqueada temporalmente, código ${j.errorcode ?? '?'}${extra}`;
}
function redact(s) {
    return s.replace(/("?(?:Passwd|password|token)"?\s*[:=]\s*")[^"]*/gi, '$1***').slice(0, 300);
}
