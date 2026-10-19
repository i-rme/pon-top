# pon-top

Monitor en tiempo real, estilo `htop`, del estado de la fibra (PON / XGS-PON) del router
**TP-Link XGB430v Pro de Digi**. Habla directamente con la API cifrada del router, sin
navegador, y muestra lo mismo que *Avanzado > Estado*, más disponibilidad, ritmos, eventos y avisos,
y lo registra todo para poder sacar un informe.

```
 pon-top  192.168.1.1  XGB430v Pro · 0.2.0 3.2.1 v60c3.0             12:18:42 · cada 5s · ● en vivo
 ⚠ 12:17:27  SALTO_RX  RX -27.45 → -17.67 dBm (+9.8 dB)
 PON   XGSPON   ONU 131   O5 registrada   FEC ↑On ↓On
 RX  -17.67 dBm  [████████████████████████████████░░░░░░░░░░░░░░░░░░░░░░]  margen 10.3 dB
      mín -27.45  máx -17.67  (17.1 µW)
      ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▂▂▂▂▂▂▂▂▂▂▂▂▂▂✖✖✖✖✖▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇
      escala -30…-14 dBm · ✖ = no registrada · últimas 90 lecturas
 TX    6.02 dBm   Temp 47.6 °C   Vcc 3.333 V   Bias 17.70 mA
────────────────────────────────────────────────────────────────────────────────────────────────────
 Tráfico  ↓   4.80 Mb/s  ↑  480.0 kb/s   pkts ↓ 80/s ↑ 40/s
 OMCI     ↑ 748  ↓ 728  (1.1/min)   PON total ↓ 836.0k ↑ 418.0k pkts
 Router   uptime 14h 0m   CPU 9%   RAM 41%   WAN PPPoE Connected 192.0.2.10
────────────────────────────────────────────────────────────────────────────────────────────────────
 Sesión   7m 30s · 90 lect.   caídas 1 · saltos RX 2 · re-reg 1 · reinicios 0 · WAN 1 · errores 0
 Tiempos  disponibilidad 94.38% (caída 25s) · RX < -26 38% · niveles RX -17.67 62%, -27.45 38%
────────────────────────────────────────────────────────────────────────────────────────────────────
 Eventos
  12:17:27  RX_NORMAL          RX -17.67 dBm, recuperada tras 2m 50s
  12:17:27  SALTO_RX           RX -27.45 → -17.67 dBm (+9.8 dB)
  12:16:12  WAN_OK             WAN conectada (192.0.2.10)
  12:16:12  POSIBLE_REREGISTRO OMCI +8 en 5s
  12:16:12  PON_RECUPERADA     Registrada de nuevo (O5) tras 25s
  12:15:47  WAN_CAIDA          WAN: Connected → Disconnected
```

## Requisitos

- Node.js 20 o superior (`node --version`)
- Estar en la red local del router

No tiene dependencias en tiempo de ejecución: la carpeta `dist/` ya viene compilada.

## Uso

```bash
node dist/main.js                 # monitor interactivo (pregunta usuario y contraseña)
node dist/main.js -i 3            # leer cada 3 s
node dist/main.js report          # informe de todo lo registrado, listo para la avería
node dist/main.js --json          # una línea JSON por lectura, sin interfaz
node dist/main.js dump            # vuelca los datos en bruto del router y sale
node dist/main.js --demo          # datos simulados, para ver la interfaz sin router
```

El usuario por defecto es `user`; pulsa Intro para usarlo o escribe otro.

Teclas: `q` salir · `p` pausa · `r` leer ahora · `+`/`-` intervalo · `v` datos en bruto del
router · `m` silenciar avisos · `l` reconectar.

Además de la potencia y el estado, la pantalla muestra la **disponibilidad** (porcentaje del
tiempo con la ONU registrada), el tiempo con RX bajo y en qué niveles de RX ha estado la línea.

### Registro

Por defecto todo se guarda en la carpeta `pon-logs/` (permisos `700`, ficheros `600`):

- `pon-AAAA-MM-DD.jsonl`: un fichero por día (cambia solo a medianoche) con:
  - `meta`: inicio de la sesión, con la información completa del router (modelo, firmware…)
  - `sample`: cada lectura, con los valores convertidos **y los objetos en bruto** del router
  - `wan`: la lista completa de conexiones WAN, cada vez que cambia
  - `event`, `session`, `error`: eventos, inicio y fin de sesión, pausas, reconexiones y fallos
- `eventos.log`: los eventos en texto, para leerlos o seguirlos con `tail -f pon-logs/eventos.log`

Opciones: `--log-dir otra/carpeta`, `--log fichero.jsonl` (un único fichero) o `--no-log`.

### Avisos

Cada evento importante genera un banner en pantalla, un pitido y una notificación del sistema
(macOS, Linux y Windows). Para no saturar, el mismo tipo de aviso no se repite en 60 s
(`--cooldown`); los que se agrupan se indican con «+N similares».

| Evento | Aviso | Qué significa |
|---|---|---|
| `PON_CAIDA` / `PON_RECUPERADA` | alerta / info | la ONU sale de O5 (registrada) y vuelve, con la duración del corte |
| `SALTO_RX` | aviso | la potencia recibida cambia 3 dB o más entre lecturas (`--alert-jump`) |
| `RX_BAJO` / `RX_NORMAL` | aviso / info | RX por debajo de -26 dBm y su recuperación (`--alert-rx`) |
| `POSIBLE_REREGISTRO` | aviso | ráfaga de mensajes OMCI muy por encima de lo normal |
| `REINICIO_ROUTER` | alerta | el uptime del router ha vuelto a empezar |
| `CONTADORES_A_CERO` | aviso | los contadores PON se han reiniciado sin reinicio del router |
| `WAN_CAIDA` / `WAN_OK` | alerta / info | la conexión PPPoE se cae o vuelve |
| `TEMP_ALTA` | aviso | el transceptor supera 70 °C (`--alert-temp`) |
| `SIN_DATOS` / `SESION` | alerta | el router deja de responder o se pierde la sesión |

**En el móvil:** con `--webhook https://ntfy.sh/un-nombre-largo-y-dificil` cada aviso se envía
también a esa URL (instala la app ntfy y suscríbete al mismo tema). Antes de salir del
ordenador se ocultan las direcciones IP del texto. Ojo: en ntfy.sh público cualquiera que
conozca el nombre del tema puede leerlo, así que usa uno largo y aleatorio.

En pantalla, las repeticiones del mismo evento (por ejemplo, un corte que se repite cada pocos
minutos o errores de lectura seguidos) se agrupan en una sola línea, `ERROR_LECTURA (7)`, con la
hora de la última y desde cuándo ocurre. El registro sigue guardando cada una por separado.

Si la RX cambia mientras la fibra está caída, el salto se detecta igualmente al volver
(«tras un corte»), y la ráfaga de mensajes OMCI de una recuperación se considera parte de la
caída, no un re-registro aparte. Como conexión WAN se muestra la de la ruta por defecto (la de
Internet), igual que en la web del router.

Desactívalos con `--no-notify` (sin notificaciones del sistema) o `--no-bell` (sin pitido), o
pulsa `m` para silenciarlos un rato.

### Informe

`node dist/main.js report` analiza todos los registros de `pon-logs/` (o los ficheros/carpetas
que le indiques) y genera un informe con: disponibilidad, lista de caídas con su duración y
la potencia previa, tiempo en cada nivel de RX, cambios bruscos, re-registros, reinicios,
huecos sin datos y un **texto listo para pegar en la avería de Digi**. Con `--out informe.md`
lo guarda en un fichero. Revisa el texto antes de enviarlo: da por hecho que ya has
descartado el latiguillo y los conectores de casa.

## Seguridad

- **La contraseña solo se pide por teclado**, sin eco. No se acepta como argumento (quedaría
  en el historial y en `ps`) ni por variable de entorno, y nunca se escribe en disco.
- Se mantiene en memoria mientras corre el programa solo para poder reconectar (`l` o
  `--relogin`) si se pierde la sesión.
- Usa el mismo cifrado que la web: la contraseña viaja cifrada con AES y la clave AES va
  firmada con la clave RSA del router. Ojo: el router solo habla HTTP y su RSA es de 512
  bits, así que este canal solo es razonable **dentro de tu red local**. Por eso pon-top se
  niega a conectar a direcciones que no sean privadas salvo con `--allow-public`.
- **El router admite una sola sesión de administración.** Si hay otra abierta (por ejemplo,
  tu navegador), pon-top avisa y pide confirmación antes de cerrarla (`--force` para no
  preguntar). Al salir hace *logout* para liberar la sesión.
- Hace un único intento de login por ejecución, para no acercarte al bloqueo por intentos
  fallidos del router.
- Los registros se crean con permisos `600` (carpeta `700`) y no contienen credenciales.
  `--debug` escribe una traza del protocolo en `pon-top-debug.log` sin contraseñas ni tokens.
- Las notificaciones se lanzan sin pasar por una shell, y lo que sale hacia un webhook va sin
  direcciones IP.
- Solo lee datos: no envía ninguna operación que cambie la configuración del router.

## Cómo funciona

Replica lo que hace la web del router (`js/tpEncrypt.js`, `js/encrypt.js`, `js/gdprProxy.js`):

1. `POST /cgi/getGDPRParm` devuelve la clave pública RSA (`nn`, `ee`) y un número `seq`.
2. Genera una clave e IV AES de 16 caracteres y `hash = MD5(usuario + contraseña)`.
3. Login: `POST /cgi_gdpr?9` con `sign=<RSA(key=..&iv=..&h=hash&s=seq+len)>` y
   `data=<AES({"operation":"cgi","oid":"/cgi/login",...})>`.
4. El token de sesión sale de la página principal y va en la cabecera `TokenID`.
5. Lecturas: `POST /cgi_gdpr?9` con `{"operation":"gl","oid":"DEV2_OPTC_GPON_CFG"}`, etc.,
   firmadas con `h=hash&s=seq+len`, y la respuesta se descifra con la misma clave AES.

Las conversiones son las de `main/status.htm`: RX/TX vienen en décimas de µW
(`dBm = 10·log10(x/10000)`), la corriente del láser en unidades de 2 µA y la temperatura con
su propio desplazamiento.

## Si algo falla

- `node dist/main.js dump --debug` vuelca los datos en bruto y deja una traza en
  `pon-top-debug.log`. Con eso se puede ajustar cualquier diferencia de firmware.
- *"Login aceptado pero no encuentro el token"*: el firmware entrega el token de otra forma;
  la traza de `--debug` muestra dónde.

## Desarrollo

```bash
npm install
npm run build      # compila src/ a dist/
npm test           # cifrado contra CryptoJS, eventos, avisos, registro, informe y flujo completo contra un router simulado
npm run dev        # ejecutar desde el código TypeScript
```
