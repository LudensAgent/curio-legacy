// 代码技能沙箱的工作线程：在独立线程里用 vm 跑模型写的代码，死循环时由主线程直接终止这个线程。
// 和 vm 上下文之间只传字符串；和主线程之间用消息。
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

const METHODS = workerData.methods;
const BOOT = `"use strict";
const __q = []; const __p = new Map(); let __id = 0; let __state = { done: false };
const __call = (m, a) => new Promise((res, rej) => { const id = ++__id; __p.set(id, { res, rej }); __q.push(JSON.stringify({ t: 'call', id, m, a })); });
const api = Object.freeze({
${METHODS.map((m) => `  ${m}: (...a) => __call(${JSON.stringify(m)}, a),`).join('\n')}
  log: (...t) => { __q.push(JSON.stringify({ t: 'log', text: t.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ').slice(0, 300) })); },
  progress: (p) => { __q.push(JSON.stringify({ t: 'progress', p: Number(p) || 0 })); },
});
globalThis.__drain = () => JSON.stringify(__q.splice(0));
globalThis.__pending = () => __p.size;
globalThis.__resolve = (id, json, isError) => { const p = __p.get(id); if (!p) return; __p.delete(id); if (isError) p.rej(new Error(json)); else p.res(JSON.parse(json)); };
globalThis.__status = () => { try { return JSON.stringify(__state); } catch (e) { return JSON.stringify({ done: true, ok: true, result: String(__state.result) }); } };
globalThis.__start = (argsJson) => {
  const args = Object.freeze(JSON.parse(argsJson));
  Promise.resolve().then(() => __user(api, args)).then(
    (r) => { __state = { done: true, ok: true, result: r === undefined ? null : r }; },
    (e) => { __state = { done: true, ok: false, error: String((e && e.stack) || e) }; });
};`;

const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
const run = (src) => vm.runInContext(src, context, { filename: 'host.js' });
let finished = false;

function pump() {
  if (finished) return;
  let queue, status;
  try { queue = JSON.parse(run('__drain()')); status = JSON.parse(run('__status()')); } catch (e) { finish({ ok: false, error: String(e?.message ?? e) }); return; }
  for (const raw of queue) parentPort.postMessage(JSON.parse(raw));
  if (status.done) { finish(status); return; }
  if (!queue.length && Number(run('__pending()')) === 0) finish({ ok: false, error: '代码在等一个永远不会来的结果（Promise 没有 resolve；只有 api.* 的调用会回来）' });
}
function finish(status) { finished = true; parentPort.postMessage({ t: 'done', ok: !!status.ok, result: status.result ?? null, error: status.error }); }

parentPort.on('message', (msg) => {
  try {
    if (msg.t === 'start') {
      run(BOOT);
      new vm.Script(`const __user = async (api, args) => {\n${msg.code}\n};`, { filename: 'skill.js', lineOffset: -1 }).runInContext(context);
      run(`__start(${JSON.stringify(msg.args)})`);
    } else if (msg.t === 'result') {
      run(`__resolve(${Number(msg.id)}, ${JSON.stringify(String(msg.json))}, ${msg.isError ? 'true' : 'false'})`);
    }
  } catch (e) { finish({ ok: false, error: String(e?.stack ?? e) }); return; }
  // 等这一轮的微任务都跑完再取请求
  setImmediate(pump);
});
