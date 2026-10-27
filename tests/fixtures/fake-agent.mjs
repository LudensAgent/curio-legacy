// 守护进程测试用的假 Agent：按第几次启动决定怎么“出事”
import fs from 'node:fs';
const [, , countFile, ...plan] = process.argv;
const n = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;
fs.writeFileSync(countFile, String(n));
const what = plan[n - 1] ?? 'ok';
process.send?.({ type: 'hb', rss: 1, heapUsed: 2, heapLimit: 4 });
process.on('message', (m) => { if (m?.type === 'shutdown') { console.log('saving'); process.exit(0); } });
if (what === 'crash') { console.error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'); process.exit(134); }
if (what === 'restart') process.exit(75);
if (what === 'hang') { const end = Date.now() + 60_000; while (Date.now() < end) { /* 卡死：不再发心跳 */ } }
if (what === 'ok') setTimeout(() => process.exit(0), 50);
if (what === 'wait') setInterval(() => process.send?.({ type: 'hb' }), 50);
// 说好要忙一阵（写堆快照）：停住 7 秒不发心跳，然后正常退出
if (what === 'busy') { process.send?.({ type: 'busy', ms: 60_000 }); setTimeout(() => { const end = Date.now() + 7_000; while (Date.now() < end) { /* 写快照 */ } process.exit(0); }, 50); }
