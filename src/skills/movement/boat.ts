import { ride } from '../actions.ts';
import type { Skill } from '../types.ts';

type BoatArgs = { direction?: string; to?: { x: number; z: number }; distance: number; until?: string };

/**
 * L2 船/载具执行器：只驾驶已经乘坐的载具。
 * 不造船、不上/下船；停靠不等于到达。
 */
export const boatPath: Skill<BoatArgs> = {
  ...ride,
  name: 'boat_path',
  description: '驾驶已经乘坐的船/筏/载具沿水面或朝指定点前进；遇障碍或 until 即停，保持乘坐。arrived 仅指原目标，docked 只是停靠；不造船、不上/下船、不施工。',
  catalog: '{"direction"?:"N|NE|E|SE|S|SW|W|NW","to"?:"x,z","distance"?:8-240,"until"?:"方块/生物"}：驾驶已乘坐的船沿水面前进（direction 或 to 必给一个）；停靠不等于到达，不造船、不上下船',
  argsDoc: '{"direction"?: "N|NE|E|SE|S|SW|W|NW", "to"?: "x,z"|{"x","z"}, "distance"?: 8-240, "until"?: "<方块/生物>"}；必须先已经乘坐载具；停靠不等于到达。',
};
