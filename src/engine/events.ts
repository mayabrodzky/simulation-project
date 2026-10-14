/**
 * What the engine reports back after a tick or a command.
 *
 * Events carry facts, never formatted sentences. The engine says
 * `{ type: 'job-completed', name: 'Blood panel', revenue: 180 }`; the UI
 * decides that this reads "Task completed by Dana Cohen. +$500" and that it is
 * green. That separation is the reason the engine can run with no browser
 * attached — previously the assignment code called showNotification directly
 * from inside the business logic, which is precisely what made a headless run
 * impossible.
 *
 * It also makes the later phases additive rather than invasive: Phase 2's
 * metrics and Phase 4's verdict card are new consumers of this stream, not new
 * branches inside the simulation.
 */
import type { BlockReason, EquipmentId, JobId, Skill, StaffId } from '../domain/types';

export type RejectionReason =
  | 'not-idle'
  | 'unqualified'
  | 'no-funds'
  | 'equipment-in-use'
  | 'equipment-missing'
  | 'no-space'
  | 'already-known'
  | 'off-shift'
  /** The job was taken, finished or abandoned between showing it and clicking. */
  | 'job-not-open';

export type EngineEvent =
  | { type: 'training-started'; staffId: StaffId; staffName: string; skill: Skill; cost: number }
  | { type: 'training-completed'; staffId: StaffId; staffName: string; skill: Skill }
  /**
   * A sample turned up. Carries the facts, not a sentence: the view decides
   * whether one arrival is worth a notification or only a counter.
   */
  | { type: 'job-arrived'; jobId: JobId; name: string; dueAtMinute: number }
  | { type: 'job-assigned'; jobId: JobId; name: string; staffId: StaffId; staffName: string }
  /** `minutesLate` is zero when on time, so a caller needs no second check. */
  | {
      type: 'job-completed';
      jobId: JobId;
      name: string;
      onTime: boolean;
      revenue: number;
      minutesLate: number;
    }
  /**
   * A step finished and the person cannot do the next one, so the job went back
   * to the queue part-finished. Not a failure — it is how a sample moves
   * between specialists — but worth reporting, because a job that waits a long
   * time for its second specialist is a real cost with no other symptom.
   */
  | {
      type: 'job-handed-over';
      jobId: JobId;
      name: string;
      staffId: StaffId;
      staffName: string;
      nextStep: string;
    }
  /**
   * The operator has finished their part and the instrument is now running
   * alone. They are free from this instant, which is the point of reporting it:
   * an instrument being the constraint is a different sentence from its
   * scientist being the constraint.
   */
  | {
      type: 'job-unattended';
      jobId: JobId;
      name: string;
      staffId: StaffId;
      staffName: string;
      minutes: number;
    }
  /** An unattended run finished and the instrument is free again. */
  | { type: 'job-off-instrument'; jobId: JobId; name: string; stepsLeft: number }
  /**
   * Nothing has moved this job for a long time, and here is what is in the way.
   *
   * Reported once per continuous block. Changes nothing — it exists so that a
   * run which fails by doing nothing says so, rather than looking like a
   * working run with a disappointing result.
   */
  | {
      type: 'job-stalled';
      jobId: JobId;
      name: string;
      reason: BlockReason;
      blockedForMinutes: number;
    }
  /** The client gave up. Nothing is charged; the work is simply not paid for. */
  | { type: 'job-expired'; jobId: JobId; name: string; workingDaysLate: number }
  | {
      type: 'equipment-serviced';
      equipmentId: EquipmentId;
      equipmentName: string;
      kind: 'repair' | 'calibrate';
      cost: number;
    }
  | {
      type: 'equipment-purchased';
      equipmentId: EquipmentId;
      equipmentName: string;
      cost: number;
    }
  | { type: 'staff-status-changed'; staffId: StaffId; staffName: string; status: string }
  | { type: 'shift-toggled'; staffId: StaffId; staffName: string; onShift: boolean }
  /**
   * Somebody reached the daily hours cap and went home mid-step.
   *
   * Distinct from a shift ending, because the cause is different and a manager
   * would want to know which: one is the lab closing, the other is a person
   * having worked twelve hours.
   */
  | {
      type: 'hours-cap-reached';
      staffId: StaffId;
      staffName: string;
      minutesWorked: number;
      jobSetDown: JobId | null;
    }
  /** The clock brought someone in. Distinct from a roster change. */
  | { type: 'shift-started'; staffId: StaffId; staffName: string }
  /**
   * The clock sent someone home. `jobSetDown` names the job they put down, if
   * any — work carried over to tomorrow is a cost worth being able to count.
   */
  | { type: 'shift-ended'; staffId: StaffId; staffName: string; jobSetDown: JobId | null }
  | { type: 'rejected'; reason: RejectionReason; detail?: string };

/** True for events that change something a sidebar panel displays. */
export function isPanelAffecting(event: EngineEvent): boolean {
  return event.type !== 'rejected';
}
