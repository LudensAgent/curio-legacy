import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { RESOURCE_PRINCIPLE } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('资源前瞻原则：用途、判断边界、背包/安全/时间并列，不替 Agent 做囤积取舍', () => {
  assert.match(RESOURCE_PRINCIPLE, /资源用来支持后面的行动/);
  assert.match(RESOURCE_PRINCIPLE, /由你判断/);
  assert.match(RESOURCE_PRINCIPLE, /背包、安全和时间是一起权衡的事实/);
  assert.doesNotMatch(RESOURCE_PRINCIPLE, /不为囤积/);
});

test('gather/smelt 说明：count 是这段活结束时的目标总数/要烧的总数', () => {
  assert.match(SKILLS.gather!.description, /这段活结束时背包里这类物品的目标总数/);
  assert.match(SKILLS.gather!.argsDoc, /包含已有的；只采缺口/);
  assert.match(SKILLS.smelt!.description, /这段活要烧掉的总数/);
  assert.match(SKILLS.smelt!.argsDoc, /这段活要烧掉的总数/);
});
