/**
 * Formatting durations for display.
 *
 * Kept with the engine rather than the UI because it encodes a model
 * assumption, not a presentation choice: these values are treated as seconds.
 *
 * That assumption is currently inconsistent across the codebase — a task step's
 * `duration` is counted down in simulated seconds but labelled "min" in the
 * task modal, while the clock advances half a simulated minute per second.
 * Phase 1 preserves the behaviour rather than correcting it, because changing
 * it changes how fast the game feels and there are no tests yet to catch that.
 * Phase 2 fixes the units alongside the explicit-assumptions work, where
 * recalibrating is the point.
 */
export function formatDuration(totalSeconds: number, showSeconds = false): string {
  const t = Math.max(0, totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  if (showSeconds) return `${m}m ${s.toString().padStart(2, '0')}s`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
