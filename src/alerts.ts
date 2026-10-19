// Avisos: pitido en la terminal, notificación del sistema y webhook opcional (compatible con ntfy)
import { execFile } from 'node:child_process';
import type { MonEvent, EventKind } from './monitor.js';

export interface AlertConfig {
  bell: boolean;
  desktop: boolean;
  webhook: string | null;
  /** No repetir el mismo tipo de aviso antes de este tiempo (s) */
  cooldownSec: number;
}

/** Eventos que generan aviso (los de severidad info solo si son buenas noticias tras un problema) */
const NOTIFY: ReadonlySet<EventKind> = new Set<EventKind>([
  'PON_CAIDA', 'PON_RECUPERADA', 'SALTO_RX', 'RX_BAJO', 'RX_NORMAL', 'POSIBLE_REREGISTRO',
  'REINICIO_ROUTER', 'CONTADORES_A_CERO', 'WAN_CAIDA', 'WAN_OK', 'TEMP_ALTA', 'SIN_DATOS', 'SESION',
]);

const TITLES: Partial<Record<EventKind, string>> = {
  PON_CAIDA: 'Fibra caída', PON_RECUPERADA: 'Fibra recuperada', SALTO_RX: 'Salto de potencia RX',
  RX_BAJO: 'Potencia RX baja', RX_NORMAL: 'Potencia RX normal', POSIBLE_REREGISTRO: 'Posible re-registro PON',
  REINICIO_ROUTER: 'Router reiniciado', CONTADORES_A_CERO: 'Contadores PON a cero', WAN_CAIDA: 'Internet caído',
  WAN_OK: 'Internet recuperado', TEMP_ALTA: 'Temperatura alta', SIN_DATOS: 'El router no responde', SESION: 'Sesión perdida',
};

/** Quita direcciones IP antes de mandar un aviso fuera del ordenador */
export function maskIps(s: string): string {
  return s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'x.x.x.x').replace(/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, 'x::x');
}

/** Cadena AppleScript con comillas escapadas (se pasa como argumento, sin shell) */
export function appleString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export class Alerter {
  private lastByKind = new Map<EventKind, number>();
  private suppressed = new Map<EventKind, number>();
  muted = false;
  sent = 0;

  constructor(
    private cfg: AlertConfig,
    private hooks: { bell?: () => void; now?: () => number; notifyImpl?: (title: string, body: string) => void; webhookImpl?: (title: string, body: string, urgent: boolean) => void } = {},
  ) {}

  /** Decide si avisar de un evento y lo hace. Devuelve true si se ha avisado. */
  handle(e: MonEvent): boolean {
    if (this.muted || !NOTIFY.has(e.kind)) return false;
    const now = (this.hooks.now ?? Date.now)();
    const last = this.lastByKind.get(e.kind);
    if (last !== undefined && now - last < this.cfg.cooldownSec * 1000) {
      this.suppressed.set(e.kind, (this.suppressed.get(e.kind) ?? 0) + 1);
      return false;
    }
    this.lastByKind.set(e.kind, now);
    const extra = this.suppressed.get(e.kind);
    this.suppressed.delete(e.kind);

    const title = `pon-top: ${TITLES[e.kind] ?? e.kind}`;
    const body = maskIps(e.msg) + (extra ? ` (+${extra} similares)` : '');
    const urgent = e.sev === 'alerta';

    if (this.cfg.bell && e.sev !== 'info') this.hooks.bell?.();
    if (this.cfg.desktop) (this.hooks.notifyImpl ?? desktopNotify)(title, body);
    if (this.cfg.webhook) (this.hooks.webhookImpl ?? ((t, b, u) => void postWebhook(this.cfg.webhook!, t, b, u)))(title, body, urgent);
    this.sent++;
    return true;
  }
}

function desktopNotify(title: string, body: string): void {
  const done = () => {};
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${appleString(body)} with title ${appleString(title)} sound name "Submarine"`], done);
  } else if (process.platform === 'linux') {
    execFile('notify-send', ['-a', 'pon-top', title, body], done);
  } else if (process.platform === 'win32') {
    const ps = `[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];` +
      `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1);` +
      `$t=$x.GetElementsByTagName('text');$t.Item(0).AppendChild($x.CreateTextNode($env:PT_T))|Out-Null;$t.Item(1).AppendChild($x.CreateTextNode($env:PT_B))|Out-Null;` +
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('pon-top').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    execFile('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, PT_T: title, PT_B: body } }, done);
  }
}

async function postWebhook(url: string, title: string, body: string, urgent: boolean): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      // Cabeceras de ntfy; otros servicios simplemente reciben el texto
      // (el título va en la primera línea del cuerpo: las cabeceras HTTP no admiten tildes)
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Priority: urgent ? 'high' : 'default', Tags: urgent ? 'rotating_light' : 'warning' },
      body: `${title}\n${body}`,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    /* un aviso que no sale no debe tumbar el monitor */
  }
}
