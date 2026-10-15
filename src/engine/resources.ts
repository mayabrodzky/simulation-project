/**
 * Instruments: what they can do, how many there are, and how many jobs each
 * can hold at once.
 *
 * This replaces matching a step to a machine **by exact name**, which was the
 * single most consequential limitation carried out of Phase 1. Naming the
 * machine made capacity a name rather than a count: the shop sold "Microscope
 * B", no step asked for it, and so buying a second instrument could never
 * relieve anything. A step now asks for a *capability* and any instrument
 * offering it will do — which is what turns "lease a second mass spectrometer"
 * from a sprite into a decision the model can evaluate.
 *
 * Three ideas that are easy to conflate and must not be:
 *
 * - **Capability** is what an instrument can do, and what a step asks for.
 * - **Count** is how many of an instrument the lab owns. This is the decision.
 * - **Capacity** is how many jobs one instrument holds at once. This is
 *   physics: an incubator has shelves, a centrifuge has one rotor. Without it
 *   the model *jams* rather than queueing — twelve cell cultures at 48 hours is
 *   576 instrument-hours a week against 168 calendar hours, which no count can
 *   satisfy if each instrument takes one job.
 *
 * Allocation is deterministic and takes no randomness: the lowest-numbered
 * instrument with a free slot. A tie broken by chance would mean two runs of
 * the same seed could use different instruments and wear them differently.
 */
import type { Capability, Equipment, Job, JobId } from '../domain/types';
import type { WorldState } from './world';

/** Whether this instrument can do this kind of work. */
export function provides(resource: Equipment, capability: Capability): boolean {
  return resource.capabilities.includes(capability);
}

export function hasFreeSlot(resource: Equipment): boolean {
  return resource.heldBy.length < resource.capacity;
}

/** Every instrument offering a capability, in a stable order. */
export function instrumentsFor(world: WorldState, capability: Capability): Equipment[] {
  return world.equipment.filter((r) => provides(r, capability));
}

/**
 * The instrument a job should use for a capability, or undefined if all are
 * occupied.
 *
 * Lowest id with a free slot. Deliberately not "least worn" or "nearest",
 * either of which would be defensible and both of which would make the choice
 * depend on history in ways a comparison between two options would then have to
 * control for.
 */
export function allocate(world: WorldState, capability: Capability): Equipment | undefined {
  let best: Equipment | undefined;
  for (const resource of world.equipment) {
    if (!provides(resource, capability)) continue;
    if (!hasFreeSlot(resource)) continue;
    if (best === undefined || resource.id < best.id) best = resource;
  }
  return best;
}

/** Whether the lab owns anything at all that could do this. */
export function existsFor(world: WorldState, capability: Capability): boolean {
  return world.equipment.some((r) => provides(r, capability));
}

/** Whether every instrument offering this capability is currently full. */
export function allBusyFor(world: WorldState, capability: Capability): boolean {
  const owned = instrumentsFor(world, capability);
  return owned.length > 0 && owned.every((r) => !hasFreeSlot(r));
}

/** Takes a slot on an instrument for a job. */
export function claim(world: WorldState, resource: Equipment, job: Job): void {
  if (!resource.heldBy.includes(job.id)) resource.heldBy.push(job.id);
  job.equipmentId = resource.id;
  syncLegacyFields(resource, world);
}

/**
 * Gives back the slot this job holds, wherever it holds one.
 *
 * Searches rather than trusting `job.equipmentId`, so a job can never leave a
 * slot occupied by being released twice or released after its id was cleared.
 * An instrument stuck at full capacity with nothing in it would deadlock
 * silently, which is the failure shape this whole phase keeps guarding against.
 */
export function releaseSlots(world: WorldState, jobId: JobId): void {
  for (const resource of world.equipment) {
    const at = resource.heldBy.indexOf(jobId);
    if (at === -1) continue;
    resource.heldBy.splice(at, 1);
    syncLegacyFields(resource, world);
  }
}

/**
 * Keeps `inUse` and `assignedTo` agreeing with `heldBy`.
 *
 * Both exist only for the renderer and the equipment panel, which were written
 * against one job per machine. Derived in one place so they cannot drift from
 * the thing they describe; A5's view work removes them.
 */
export function syncLegacyFields(resource: Equipment, world: WorldState): void {
  resource.inUse = resource.heldBy.length > 0;
  if (!resource.inUse) {
    resource.assignedTo = null;
    return;
  }
  const first = world.jobs.find((j) => j.id === resource.heldBy[0]);
  resource.assignedTo = first?.operatorId ?? null;
}

/** Instrument time in use, as a fraction of slot-time available. For the audit. */
export function utilisation(
  world: WorldState,
  capability: Capability,
  overMinutes: number,
): number {
  const owned = instrumentsFor(world, capability);
  if (owned.length === 0 || overMinutes <= 0) return 0;
  const slotMinutes = owned.reduce((total, r) => total + r.capacity, 0) * overMinutes;
  const used = owned.reduce((total, r) => total + r.totalWorkTime, 0);
  return used / slotMinutes;
}
