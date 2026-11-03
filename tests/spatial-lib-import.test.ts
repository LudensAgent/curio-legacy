import assert from 'node:assert/strict';
import { test } from 'node:test';
// 运行时值导出：类与常量。
import { GROUNDED_ARRIVAL_DEFAULTS, RouteVerifier, VoxelMap, WalkRouteExecutor } from 'curio-minecraft-3d-memory';
// 类型导出：只 import type，不当运行时对象。
import type { BodySample, ChangeReport, CollisionShapeProvider, GroundedArrival, MoveExecutor, NavProblem, NavResult } from 'curio-minecraft-3d-memory';

test('空间库公开包入口可导入运行时值与类型', () => {
  assert.equal(typeof WalkRouteExecutor, 'function', 'WalkRouteExecutor 是运行时类');
  assert.equal(typeof VoxelMap, 'function', 'VoxelMap 是运行时类');
  assert.equal(typeof RouteVerifier, 'function', 'RouteVerifier 是运行时类');
  assert.equal(typeof GROUNDED_ARRIVAL_DEFAULTS.horizontalTolerance, 'number', '默认容差是运行时常量');
  assert.equal(GROUNDED_ARRIVAL_DEFAULTS.maxVerticalSpeed >= 0.0784, true, '竖直限速吸收静止着地重力速度');
});

// 这些类型变量只在编译期使用，运行时无对应导出；仅用于类型检查。
const _arrival: GroundedArrival = GROUNDED_ARRIVAL_DEFAULTS;
const _types: { s?: BodySample; r?: ChangeReport; p?: CollisionShapeProvider; m?: MoveExecutor; n?: NavResult; pr?: NavProblem } = {};
void _arrival; void _types;
