import { startMockRouter } from './mock-router.ts';
const m = await startMockRouter({ user: process.env.MOCK_USER ?? 'admin', password: 'secreto', omciBurst: process.argv.includes('--burst'), sessionTtlMs: Number(process.env.MOCK_TTL_MS) || undefined });
console.log('PORT', m.port);
setInterval(() => { console.log('STATE', JSON.stringify({ loginOk: m.state.loginOk, last: m.state.requests.slice(-3) })); }, 1000);
