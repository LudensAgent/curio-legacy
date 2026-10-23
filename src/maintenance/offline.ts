import net from 'node:net';

export interface ResetEndpoint { host: string; port: number; label: string }

const PROBE_TIMEOUT_MS = 800;

function normalize(endpoint: ResetEndpoint): ResetEndpoint {
  if (!endpoint || typeof endpoint.host !== 'string' || !endpoint.host.trim()
    || /[\s\x00-\x1f\x7f]/u.test(endpoint.host) || endpoint.host.length > 255) {
    throw new Error('清理前检查的服务地址无效，拒绝执行清理。');
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error('清理前检查的端口必须为 1–65535 的整数，拒绝执行清理。');
  }
  if (typeof endpoint.label !== 'string' || !endpoint.label.trim()) {
    throw new Error('清理前检查缺少服务名称，拒绝执行清理。');
  }
  let host = endpoint.host.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new Error('清理前检查的服务地址无效，拒绝执行清理。');
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::') host = '::1';
  return { host, port: endpoint.port, label: endpoint.label.trim() };
}

function probe(endpoint: ResetEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket | undefined;
    let settled = false;
    const display = `${endpoint.label} (${endpoint.host}:${endpoint.port})`;
    const uncertain = (reason: string) => new Error(`无法确认 ${display} 已停止（${reason}），拒绝清理。请检查服务地址并先停止对应的 Agent 或 Minecraft 服务器。`);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (error) reject(error);
      else resolve();
    };
    // A separate deadline also bounds DNS lookup, before socket inactivity timers apply.
    const timer = setTimeout(() => finish(uncertain('连接检查超时')), PROBE_TIMEOUT_MS);
    try {
      socket = net.createConnection({ host: endpoint.host, port: endpoint.port });
      socket.once('connect', () => finish(new Error(`检测到 ${display} 正在监听，请先停止对应的 Agent 或 Minecraft 服务器后再清理。`)));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        // Timeouts, DNS failures and access restrictions cannot prove that a service is offline.
        // Node may aggregate IPv4/IPv6 failures under only the first error's code.
        const attempts = (error as NodeJS.ErrnoException & { errors?: unknown }).errors;
        const refused = error.code === 'ECONNREFUSED' && (attempts === undefined
          || Array.isArray(attempts) && attempts.length > 0 && attempts.every((attempt) => attempt?.code === 'ECONNREFUSED'));
        if (refused) finish();
        else finish(uncertain(error.code ?? '连接失败'));
      });
      socket.once('close', () => { if (!settled) finish(uncertain('连接提前关闭')); });
    } catch (error) {
      finish(uncertain((error as NodeJS.ErrnoException)?.code ?? '连接检查失败'));
    }
  });
}

/** Read-only TCP checks. The caller must skip this network probe for dry-run. */
export async function assertResetOffline(endpoints: ResetEndpoint[]): Promise<void> {
  if (!Array.isArray(endpoints)) throw new Error('清理前检查的服务列表无效。');
  // Validate the complete plan before contacting any endpoint.
  const normalized = endpoints.map(normalize);
  const unique = new Map(normalized.map((endpoint) => [`${endpoint.host}\n${endpoint.port}`, endpoint]));
  for (const endpoint of unique.values()) await probe(endpoint);
}
