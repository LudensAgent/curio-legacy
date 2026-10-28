export const TICKS_PER_GAME_HOUR = 1000;

/** 一段刻数换成游戏时长：“约 3 个半小时”“约 40 分钟” */
export function durationText(ticks: number): string {
  const hours = Math.max(0, ticks) / TICKS_PER_GAME_HOUR;
  if (hours < 0.9) return `约 ${Math.max(5, Math.round(hours * 60 / 5) * 5)} 分钟`;
  const halves = Math.round(hours * 2);
  const whole = Math.floor(halves / 2);
  return `约 ${whole} 个${halves % 2 ? '半' : ''}小时`;
}

/** 现实秒数换成游戏时长（走路、干等这些按现实时间量出来的） */
export const realSecondsToTicks = (sec: number) => sec * 20;
