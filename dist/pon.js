const num = (v) => {
    if (v === undefined || v === null || v === '')
        return null;
    const x = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(x) ? x : null;
};
const str = (v) => (v === undefined || v === null ? null : String(v));
/** Conversiones idénticas a initPon() de status.htm */
export function decodeOptics(o) {
    const statusCode = num(o['status']);
    const state = statusCode === 0 ? 'DESC' : statusCode !== null && statusCode >= 1 && statusCode <= 7 ? `O${statusCode}` : '?';
    const rawTemp = num(o['transceiverTemperature']);
    const temp = rawTemp === null ? null : (Math.trunc(rawTemp) + 100) / 256;
    const txRaw = num(o['TXPower']);
    const rxRaw = num(o['RXPower']);
    const txDbm = txRaw === null || txRaw <= 0 ? null : 10 * Math.log10(Math.trunc(txRaw) / 10000);
    const rxDbm = rxRaw === null || rxRaw <= 0 ? null : 10 * Math.log10(Math.trunc(rxRaw) / 10000);
    const bias = num(o['biasCurrent']);
    return {
        ponType: str(o['ponType']),
        onuId: str(o['MACAddress']),
        statusCode,
        state,
        temp,
        vcc: num(o['supplyVottage']), // sic: así se llama el campo en el firmware
        bias: bias === null ? null : bias / 500,
        tx: txDbm === null || txDbm <= -10 ? null : txDbm,
        rx: rxDbm === null || rxDbm <= -40 ? null : rxDbm,
        rxRaw,
        fecUs: o['fecUsEn'] === undefined ? null : String(o['fecUsEn']) === '1',
        fecDs: o['fecDsEn'] === undefined ? null : String(o['fecDsEn']) === '1',
    };
}
/** Elige la WAN de Internet: la de la ruta por defecto (como hace la web); si no, la PPP; si no, la conectada */
export function pickWan(list, defaultConn = null) {
    const enabled = list.filter(w => String(w['enable']) === '1' && w['connType'] !== 'Bridge');
    const w = (defaultConn ? enabled.find(x => x['name'] === defaultConn) : undefined) ??
        enabled.find(x => /^PPP/i.test(String(x['connType'] ?? ''))) ??
        enabled.find(x => x['connStatusV4'] === 'Connected') ??
        enabled[0];
    if (!w)
        return null;
    return {
        name: String(w['name'] ?? ''),
        type: String(w['connType'] ?? ''),
        status: String(w['connStatusV4'] ?? '?'),
        ip: String(w['connIPv4Address'] ?? ''),
        gateway: String(w['connIPv4Gateway'] ?? ''),
    };
}
// La ruta por defecto casi nunca cambia: se consulta como mucho una vez por minuto
const routeCache = new WeakMap();
async function defaultRouteConn(client, extra) {
    const c = routeCache.get(client);
    if (c && Date.now() - c.t < 60_000)
        return c.name;
    const routes = await extra(() => client.dm('gl', 'DEV2_ROUTER_V4FWD'));
    const r = Array.isArray(routes) ? routes.find(x => String(x['enable']) === '1' && !x['destIPAddress'] && !x['destSubnetMask']) : undefined;
    const name = r ? String(r['X_TP_ConnName'] ?? '') || null : null;
    routeCache.set(client, { t: Date.now(), name });
    return name;
}
const first = (v) => (Array.isArray(v) ? (v[0] ?? {}) : (v ?? {}));
export async function readPon(client) {
    // Igual que la web: getList ("gl") de los tres objetos PON
    const optc = first(await client.dm('gl', 'DEV2_OPTC_GPON_CFG'));
    const stats = first(await client.dm('gl', 'DEV2_GPON_INTF_STATS'));
    const omci = first(await client.dm('gl', 'DEV2_GPON_INTF_OMCI_STATS'));
    // Extras (si fallan no invalidan la muestra)
    const extra = async (fn) => { try {
        return await fn();
    }
    catch {
        return null;
    } };
    const dev = await extra(() => client.dm('go', 'DEV2_DEV_INFO', { upTime: '' }));
    const cpu = await extra(() => client.dm('go', 'DEV2_PROC_STATUS', { CPUUsage: '' }));
    const mem = await extra(() => client.dm('go', 'DEV2_MEM_STATUS', { total: '', free: '' }));
    const wans = await extra(() => client.dm('gl', 'DEV2_ADT_WAN'));
    const dfltConn = await defaultRouteConn(client, extra);
    const memTotal = num(mem?.['total']);
    const memFree = num(mem?.['free']);
    return {
        t: Date.now(),
        ...decodeOptics(optc),
        bytesUp: num(stats['bytesSent']),
        bytesDown: num(stats['bytesReceived']),
        pktsUp: num(stats['packetsSent']),
        pktsDown: num(stats['packetsReceived']),
        omciUp: num(omci['packetsSent']),
        omciDown: num(omci['packetsReceived']),
        uptime: num(dev?.['upTime']),
        cpu: num(cpu?.['CPUUsage']),
        mem: memTotal && memFree !== null ? ((memTotal - memFree) / memTotal) * 100 : null,
        wan: Array.isArray(wans) ? pickWan(wans, dfltConn) : null,
        raw: { optc, stats, omci, wan: Array.isArray(wans) ? wans : null },
    };
}
/** Información completa del equipo (una vez al empezar) */
export async function readDevInfo(client) {
    try {
        return await client.dm('go', 'DEV2_DEV_INFO');
    }
    catch {
        return null;
    }
}
/** Volcado en bruto para depurar (subcomando "dump") */
export async function dumpRaw(client) {
    const out = {};
    const reqs = [
        ['gl', 'DEV2_OPTC_GPON_CFG'],
        ['gl', 'DEV2_GPON_INTF_STATS'],
        ['gl', 'DEV2_GPON_INTF_OMCI_STATS'],
        ['go', 'DEV2_DEV_INFO'],
        ['go', 'DEV2_PROC_STATUS', { CPUUsage: '' }],
        ['go', 'DEV2_MEM_STATUS', { total: '', free: '' }],
        ['gl', 'DEV2_ADT_WAN'],
    ];
    for (const [op, oid, data] of reqs) {
        try {
            out[oid] = await client.dm(op, oid, data);
        }
        catch (e) {
            out[oid] = { error: e.message };
        }
    }
    return out;
}
