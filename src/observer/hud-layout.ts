export interface HudPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Minecraft GUI pixels; the framebuffer dimensions identify the captured game image. */
export interface HudLayout {
  viewport: {
    framebufferWidth: number;
    framebufferHeight: number;
    guiWidth: number;
    guiHeight: number;
    guiScale: number;
  };
  panels: Record<string, HudPanelBounds>;
}

const PANELS = new Set(['info', 'thought', 'interests', 'stats', 'vitals', 'inventory', 'landmarks', 'view', 'containers', 'hands']);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const dimension = (value: unknown): value is number => finite(value) && Number.isInteger(value) && value >= 1 && value <= 32768;

/** Validate the mod's report once, before it enters the dashboard's in-memory state. */
export function parseHudLayout(value: unknown): HudLayout | null {
  if (!record(value) || !record(value.viewport) || !record(value.panels)) return null;
  const { framebufferWidth, framebufferHeight, guiWidth, guiHeight, guiScale } = value.viewport;
  if (!dimension(framebufferWidth) || !dimension(framebufferHeight) || !dimension(guiWidth) || !dimension(guiHeight)
    || !finite(guiScale) || guiScale <= 0) return null;
  if (Math.abs(guiWidth - Math.ceil(framebufferWidth / guiScale)) > 1
    || Math.abs(guiHeight - Math.ceil(framebufferHeight / guiScale)) > 1) return null;
  const entries = Object.entries(value.panels).map(([id, bounds]) => {
    if (!PANELS.has(id) || !record(bounds)) return null;
    const { x, y, width, height } = bounds;
    if (!finite(x) || !finite(y) || !finite(width) || !finite(height)
      || width <= 0 || height <= 0 || Math.abs(x) > 32768 || Math.abs(y) > 32768
      || width > 32768 || height > 32768) return null;
    return [id, { x, y, width, height }] as const;
  });
  if (entries.some((entry) => entry === null)) return null;
  return {
    viewport: { framebufferWidth, framebufferHeight, guiWidth, guiHeight, guiScale },
    panels: Object.fromEntries(entries.filter((entry) => entry !== null)),
  };
}
