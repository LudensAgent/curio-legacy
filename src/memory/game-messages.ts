import type { HazardKind } from './store.ts';

/**
 * 游戏自己说的话（系统消息：死亡播报、成就、进出服务器、服务器公告）。
 * 这些是游戏给出的事实，比程序根据死前状态推测的死因更可靠，要原样记进记忆。
 */
export type GameMessageKind = 'death_self' | 'death_other' | 'advancement_self' | 'advancement_other' | 'join' | 'leave' | 'server';
export interface ParsedGameMessage { kind: GameMessageKind; text: string; cause?: HazardKind; by?: string; subject?: string }

const DEATH = /\b(was slain by|was shot by|was blown up by|blew up|was killed by|was fireballed by|was stung to death|was pummeled by|was impaled|was squashed|was poked to death|was pricked to death|fell from a high place|fell off|fell out of the world|fell while|fell too far|hit the ground too hard|experienced kinetic energy|drowned|tried to swim in lava|was burnt to a crisp|burned to death|went up in flames|walked into fire|walked into the danger zone|starved to death|suffocated in a wall|was squished|froze to death|withered away|died|was obliterated|was struck by lightning|was frozen to death|discovered the floor was lava)\b/i;

export function deathCauseOf(text: string): HazardKind {
  if (/fell|hit the ground|kinetic energy|out of the world/i.test(text)) return 'fall';
  if (/lava|burn|flames|fire|crisp|danger zone|floor was lava/i.test(text)) return 'lava';
  if (/drown/i.test(text)) return 'drowning';
  if (/starv/i.test(text)) return 'starvation';
  if (/suffocat|squash|squish|crammed/i.test(text)) return 'suffocation';
  if (/slain|shot|blown up|blew up|killed by|fireballed|stung|pummeled|impaled|obliterated/i.test(text)) return 'mob';
  return 'unknown';
}

export function parseGameMessage(raw: string, me: string): ParsedGameMessage {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  const subject = text.split(' ')[0];
  const mine = !!me && subject === me;
  const by = text.match(/\bby (?:a |an )?([A-Za-z_][\w ]{0,30}?)(?: using .*)?$/)?.[1]?.trim();
  if (DEATH.test(text) && /^[A-Za-z0-9_]{2,16} /.test(text)) {
    return { kind: mine ? 'death_self' : 'death_other', text, subject, cause: deathCauseOf(text), ...(by ? { by } : {}) };
  }
  if (/has made the advancement|has completed the challenge|has reached the goal/i.test(text)) {
    return { kind: mine ? 'advancement_self' : 'advancement_other', text, subject };
  }
  if (/ joined the game$/.test(text)) return { kind: 'join', text, subject };
  if (/ left the game$/.test(text)) return { kind: 'leave', text, subject };
  return { kind: 'server', text };
}
