import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { Rcon } from '../src/observer/rcon.ts';

/** 进程内的假 RCON 服务器（模拟 Minecraft 的行为） */
function fakeServer(password: string): Promise<{ port: number; close: () => void; commands: string[] }> {
  const commands: string[] = [];
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf: Buffer = Buffer.alloc(0);
      sock.on('data', (c: Buffer) => {
        const { packets, rest } = Rcon.decode(Buffer.concat([buf, c]));
        buf = rest;
        for (const p of packets) {
          if (p.type === 3) sock.write(Rcon.encode(p.body === password ? p.id : -1, 2, ''));
          else {
            commands.push(p.body);
            sock.write(Rcon.encode(p.id, 0, p.body === 'list' ? 'There are 1 of a max of 20 players online: Curio' : `ok:${p.body}`));
          }
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close(), commands }));
  });
}

test('RCON 认证与命令往返', async () => {
  const s = await fakeServer('pw');
  const r = new Rcon('127.0.0.1', s.port, 'pw', 2000);
  assert.match(await r.send('list'), /Curio/);
  assert.equal(await r.send('spectate Curio Steve'), 'ok:spectate Curio Steve');
  assert.deepEqual(s.commands, ['list', 'spectate Curio Steve']);
  r.close();
  s.close();
});

test('RCON 密码错误时报错', async () => {
  const s = await fakeServer('pw');
  const r = new Rcon('127.0.0.1', s.port, 'wrong', 2000);
  await assert.rejects(() => r.send('list'), /认证失败/);
  r.close();
  s.close();
});

test('编码/解码可处理粘包', () => {
  const both = Buffer.concat([Rcon.encode(1, 2, 'a'), Rcon.encode(2, 0, '中文')]);
  const { packets, rest } = Rcon.decode(both.subarray(0, both.length - 3));
  assert.equal(packets.length, 1);
  const d2 = Rcon.decode(Buffer.concat([rest, both.subarray(both.length - 3)]));
  assert.equal(d2.packets[0].body, '中文');
});
