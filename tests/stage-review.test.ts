import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mind } from '../src/mind/mind.ts';
import { DEFAULT_MOOD, feel, relaxMood, SelfModel } from '../src/mind/self.ts';

test('成就感来自真正的进展：挖一格、做完一段小活不会把满足撑满；勾掉主目标的一项、做到新里程碑才明显涨', () => {
  let m = { ...DEFAULT_MOOD };
  // 一小时：每 10 秒一个成功的动作、每分钟做完一段小活（10-27 实测的节奏）
  for (let t = 1; t <= 3600; t++) {
    m = relaxMood(m, 1, true);
    if (t % 10 === 0) m = feel(m, { type: 'step', ok: true });
    if (t % 60 === 0) m = feel(m, { type: 'activity_end', outcome: 'done', sameKindStreak: 2, gainedKinds: 1 });
  }
  assert.ok(m.satisfaction < 0.8, `满足 ${m.satisfaction.toFixed(2)}`);
  const before = m.satisfaction;
  m = feel(m, { type: 'progress' });
  m = feel(m, { type: 'milestone' });
  assert.ok(m.satisfaction > before + 0.3);
});

test('无聊跟着主目标走：目标一直有进展时干活不怎么腻；很久没推进还在干，越干越腻', () => {
  let going = { ...DEFAULT_MOOD }, stuck = { ...DEFAULT_MOOD };
  for (let t = 0; t < 1800; t++) { going = relaxMood(going, 1, true); stuck = relaxMood(stuck, 1, true, { stalled: true }); }
  assert.ok(going.boredom < 0.5, `有进展 ${going.boredom.toFixed(2)}`);
  assert.ok(stuck.boredom > 0.6, `停滞 ${stuck.boredom.toFixed(2)}`);
});

test('阶段目标的经过记下来：换掉、做完各记一笔，做完主目标有成就感', () => {
  const self = new SelfModel(null);
  self.setPlan('在矿口搭前哨', ['放床', '放箱子']);
  self.setPlan('开一条固定矿道', ['推平巷', '挖 3 块粗铁']);
  assert.equal(self.stages().at(-1)?.goal, '在矿口搭前哨');
  assert.equal(self.stages().at(-1)?.outcome, 'switched');
  const sat = self.mood.satisfaction;
  self.checkPlan([0, 1]);
  self.setAgendaStatus(self.plan()!.agendaId, 'done');
  assert.equal(self.stages().at(-1)?.outcome, 'done');
  assert.equal(self.stages().at(-1)?.stepsDone, 2);
  assert.ok(self.mood.satisfaction > sat + 0.3);
});

function fakeMind(opts: { boredom: number; lastMilestoneMinAgo: number; progressMinAgo: number; days?: number }) {
  const self = new SelfModel(null);
  self.rand = () => 0.5;
  self.setPlan('攒齐熔炉和熟食，再下一趟带铁回家', ['挖到 3 块粗铁', '回地面做熔炉', '烧粗铁']);
  self.notePlanDay(60);
  assert.equal(self.data.plan!.reviewDays, 4, '回顾期限在 3–5 天里随机');
  self.data.plan!.progressAt = Date.now() - opts.progressMinAgo * 60_000;
  self.data.mood = { ...DEFAULT_MOOD, boredom: opts.boredom };
  const events: { type: string; msg: string }[] = [];
  const thinks: { reason: string; tier: string }[] = [];
  const mind = Object.create(Mind.prototype) as any;
  mind.d = {
    self, bus: { publish: (type: string, _sev: string, msg: string) => { events.push({ type, msg }); } },
    adapter: { state: () => ({ hp: 20 }) },
    progress: () => ({ reached: ['铁锭', '铁甲', '盾牌'], next: ['钻石', '下界'], lastAt: Date.now() - opts.lastMilestoneMinAgo * 60_000 }),
  };
  mind.safe = (f: () => unknown, d: unknown) => { try { return f(); } catch { return d; } };
  Object.assign(mind, { review: null, lastReviewAt: 0, reviewGapMs: 45 * 60_000, inReview: false, keptHint: null, dangerUntil: 0, order: null, gameDay: 60 + (opts.days ?? 1) });
  mind.requestThink = (reason: string, tier: string) => thinks.push({ reason, tier });
  return { mind, self, events, thinks };
}

test('腻了而且很久没有新的游戏进度：停下来认真回顾一次阶段目标，回顾时才允许换主目标', () => {
  // 10-27：清单一直有勾掉的（都是矿道、前哨这类后勤），但 11 小时没做到新的里程碑
  const { mind, self, events, thinks } = fakeMind({ boredom: 0.86, lastMilestoneMinAgo: 660, progressMinAgo: 5, days: 1 });
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1);
  assert.equal(thinks[0].tier, 'deliberate');
  assert.match(thinks[0].reason, /好无聊.*没有新的游戏进度/);
  assert.ok(events.some((e) => e.type === 'stage_review'));
  const facts = mind.stageReviewFacts();
  assert.deepEqual(facts.game_progress.not_yet, ['钻石', '下界']);
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1, '等着的回顾不重复请求');
  // 平时：认真想、写了理由，一时的想法也换不掉主目标
  const decision = { tier: 'deliberate', plan: { switchReason: '想去下界' }, notes: [] };
  assert.notEqual(mind.goalSwitchRefusal(decision, '去下界'), null);
  // 回顾这一念：可以换
  mind.inReview = true;
  assert.equal(mind.goalSwitchRefusal(decision, '去下界'), null);
  mind.inReview = false;
  self.setPlan('去下界', ['做打火石', '搭传送门']);
  mind.closeReview('old');
  assert.ok(events.some((e) => e.type === 'stage_review_done' && /换了阶段目标：去下界/.test(e.msg)));
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1, '回顾完隔一阵才再回顾');
});

test('事情正顺利、目标才刚定、或心情平稳时，不因为情绪去回顾', () => {
  const going = fakeMind({ boredom: 0.9, lastMilestoneMinAgo: 10, progressMinAgo: 5 });
  going.mind.stageReviewCheck();
  assert.equal(going.thinks.length, 0, '清单在推进、刚做到新里程碑');
  const fresh = fakeMind({ boredom: 0.9, lastMilestoneMinAgo: 600, progressMinAgo: 5, days: 0 });
  fresh.mind.stageReviewCheck();
  assert.equal(fresh.thinks.length, 0, '目标定下还不到一天');
  const calm = fakeMind({ boredom: 0.3, lastMilestoneMinAgo: 600, progressMinAgo: 60, days: 2 });
  calm.mind.stageReviewCheck();
  assert.equal(calm.thinks.length, 0, '心情平稳、也没到期限');
});

test('主目标过了 3–5 个游戏天还没做成：不管心情都回顾一次；接着做就再宽限一两天', () => {
  const { mind, self, thinks } = fakeMind({ boredom: 0.3, lastMilestoneMinAgo: 30, progressMinAgo: 5, days: 4 });
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1);
  assert.match(thinks[0].reason, /定下 4 天了还没做成/);
  const id = self.plan()!.agendaId;
  mind.closeReview(id);
  assert.equal(self.data.plan!.reviewDays, 5.5, '接着做：期限往后推 1–2 天');
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1);
  assert.ok(mind.reviewGapMs >= 45 * 60_000 && mind.reviewGapMs <= 90 * 60_000, '下次情绪提醒隔 45–90 分钟');
});

test('错过多个回顾期限后，继续目标仍从当前游戏天起宽限', () => {
  const { mind, self, thinks } = fakeMind({ boredom: 0.3, lastMilestoneMinAgo: 30, progressMinAgo: 5, days: 10 });
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1);
  mind.closeReview(self.plan()!.agendaId);
  assert.equal(self.data.plan!.reviewDays, 11.5);
  mind.stageReviewCheck();
  assert.equal(thinks.length, 1, '不会连续追补已经错过的回顾');
});
