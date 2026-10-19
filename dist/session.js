// Mantiene la sesión con el router: el firmware la cierra a los ~10 minutos (HTTP 406), así que
// cuando caduca se vuelve a iniciar con las mismas credenciales y se repite la lectura.
import { RouterError } from './client.js';
/** Espera entre intentos de reconexión fallidos por red: 5 s, 15 s, 30 s, 60 s, 2 min, 5 min… */
const BACKOFF_S = [5, 15, 30, 60, 120, 300];
export class SessionKeeper {
    client;
    login;
    opts;
    renewals = 0;
    failures = 0;
    notBefore = 0;
    locked = null;
    waiting = false;
    constructor(client, login, opts) {
        this.client = client;
        this.login = login;
        this.opts = opts;
    }
    now() {
        return (this.opts.now ?? Date.now)();
    }
    /** Motivo por el que no se puede reconectar solo (credenciales rechazadas), o null */
    get blocked() {
        return this.locked;
    }
    /** Ejecuta una lectura; si la sesión ha caducado, la renueva y repite la lectura una vez */
    async run(fn) {
        try {
            return await fn();
        }
        catch (e) {
            if (!(e instanceof RouterError) || e.code !== 'SESSION' || !this.opts.auto)
                throw e;
            await this.renew();
            return await fn();
        }
    }
    /** Vuelve a iniciar sesión. Lanza RouterError('SESSION') si todavía no se puede. */
    async renew(manual = false) {
        if (manual) {
            this.locked = null;
            this.notBefore = 0;
        }
        if (this.locked)
            throw new RouterError(this.locked, 'SESSION');
        const now = this.now();
        if (now < this.notBefore) {
            throw new RouterError(`Sesión cerrada por el router; nuevo intento en ${Math.ceil((this.notBefore - now) / 1000)} s`, 'SESSION');
        }
        // No echar a quien haya entrado en la web del router mientras tanto
        if (!this.opts.force && !manual) {
            let busy = null;
            try {
                busy = await this.client.getBusy();
            }
            catch { /* si falla, se intenta entrar igualmente */ }
            if (busy?.isLogined) {
                this.notBefore = now + 60_000;
                const msg = 'Hay otra sesión abierta en el router (¿la web?): se reintenta cada minuto sin cerrarla; pulsa l para entrar igualmente';
                if (!this.waiting)
                    this.opts.onNote?.({ kind: 'waiting', msg }); // avisar una vez, no cada minuto
                this.waiting = true;
                throw new RouterError(msg, 'SESSION');
            }
        }
        try {
            await this.login();
        }
        catch (e) {
            const err = e;
            if (err.code === 'NET' || err.code === 'HTTP' || err.code === 'TOKEN' || err.code === 'PARM') {
                const wait = BACKOFF_S[Math.min(this.failures, BACKOFF_S.length - 1)];
                this.failures++;
                this.notBefore = this.now() + wait * 1000;
                const msg = `No se pudo volver a entrar (${err.message}); nuevo intento en ${wait} s`;
                if (this.failures === 1 || wait === BACKOFF_S[BACKOFF_S.length - 1])
                    this.opts.onNote?.({ kind: 'failed', msg, fatal: false });
                throw new RouterError(msg, 'SESSION');
            }
            // Credenciales rechazadas o cuenta bloqueada: no insistir para no provocar (más) bloqueos
            this.locked = `El router ha rechazado el inicio de sesión (${err.message}). Pulsa l para reintentar a mano.`;
            this.opts.onNote?.({ kind: 'failed', msg: this.locked, fatal: true });
            throw new RouterError(this.locked, 'SESSION');
        }
        this.failures = 0;
        this.notBefore = 0;
        this.waiting = false;
        this.renewals++;
        this.opts.onNote?.({ kind: 'renewed', msg: manual ? 'Sesión iniciada de nuevo' : 'Sesión renovada (el router la había cerrado)' });
    }
}
