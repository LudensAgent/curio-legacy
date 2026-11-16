/**
 * 给事件/死亡上下文用的短任务标签：动作名加目标。
 * 目标是对象时写 JSON（例如 travel_to 的 {x,y,z}），不能变成 "[object Object]"。
 */
export const taskKey = (t: { skill: string; args?: unknown } | null | undefined) => {
  if (!t) return undefined;
  const a = (t.args ?? {}) as Record<string, unknown>;
  const key = a.block ?? a.item ?? a.animal ?? a.target ?? a.to ?? a.direction ?? a.blueprint ?? '';
  const text = typeof key === 'string' ? key : JSON.stringify(key);
  return `${t.skill}${text ? ` ${text}` : ''}`;
};
