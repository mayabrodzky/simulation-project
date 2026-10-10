/**
 * Formatting durations for display.
 *
 * Kept with the engine rather than the interface because it encodes the unit,
 * which is a property of the model: everything the engine measures is in
 * simulated minutes. Step durations, deadlines, machine time and overtime are
 * all the same kind of quantity.
 *
 * This replaces a formatter that took seconds, from when a step authored as
 * `duration: 20` was counted in simulated seconds while the interface labelled
 * it "min". The two now agree.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/**
 * A duration in minutes, as a person would say it: "2h 15m", "45m", "3d 4h".
 *
 * Days appear because an incubation runs for 48 hours, and "2880m" tells a lab
 * manager nothing.
 */
export function formatMinutes(totalMinutes: number): string {
  const total = Math.max(0, Math.round(totalMinutes));
  if (total < MINUTES_PER_HOUR) return `${total}m`;

  if (total < MINUTES_PER_DAY) {
    const h = Math.floor(total / MINUTES_PER_HOUR);
    const m = total % MINUTES_PER_HOUR;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  const d = Math.floor(total / MINUTES_PER_DAY);
  const h = Math.floor((total % MINUTES_PER_DAY) / MINUTES_PER_HOUR);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}
