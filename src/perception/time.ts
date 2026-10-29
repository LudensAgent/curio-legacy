export const TICKS_PER_GAME_HOUR = 1000;

/** 一段刻数换成现实时长：“约 40 秒”“约 3 分半”。统一用现实时间，别再用“游戏小时”——“小时”听着久，其实 1 游戏小时只有 50 现实秒。 */
export function durationText(ticks: number): string {
  const seconds = Math.max(0, ticks) / 20; // 1 tick = 1/20 现实秒
  if (seconds < 60) return `约 ${Math.max(5, Math.round(seconds / 5) * 5)} 秒`;
  const halves = Math.round(seconds / 30);
  const whole = Math.floor(halves / 2);
  return `约 ${whole} 分${halves % 2 ? '半' : ''}`;
}

/** 现实秒数换成游戏时长（走路、干等这些按现实时间量出来的） */
export const realSecondsToTicks = (sec: number) => sec * 20;
