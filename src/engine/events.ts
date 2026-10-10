/**
 * What the engine reports back after a tick or a command.
 *
 * Events carry facts, never formatted sentences. The engine says
 * `{ type: 'task-completed', staffName: 'Dana Cohen', reward: 500 }`; the UI
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
import type { EquipmentId, JobId, Skill, StaffId } from '../domain/types';

export type RejectionReason =
  | 'not-idle'
  | 'unqualified'
  | 'no-funds'
  | 'equipment-in-use'
  | 'equipment-missing'
  | 'no-space'
  | 'already-known'
  | 'off-shift';

export type EngineEvent =
  | { type: 'task-assigned'; staffId: StaffId; staffName: string; taskName: string }
  | {
      type: 'task-completed';
      staffId: StaffId;
      staffName: string;
      taskName: string;
      reward: number;
    }
  | {
      type: 'task-failed';
      staffId: StaffId;
      staffName: string;
      taskName: string;
      penalty: number;
    }
  | { type: 'training-started'; staffId: StaffId; staffName: string; skill: Skill; cost: number }
  | { type: 'training-completed'; staffId: StaffId; staffName: string; skill: Skill }
  /**
   * A sample turned up. Carries the facts, not a sentence: the view decides
   * whether one arrival is worth a notification or only a counter.
   */
  | { type: 'job-arrived'; jobId: JobId; name: string; dueAtMinute: number }
  | { type: 'emergency-raised'; emergencyId: string; name: string }
  | { type: 'emergency-expired'; emergencyId: string; name: string; penalty: number }
  | { type: 'emergency-resolved'; emergencyId: string; name: string }
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
  | { type: 'rejected'; reason: RejectionReason; detail?: string };

/** True for events that change something a sidebar panel displays. */
export function isPanelAffecting(event: EngineEvent): boolean {
  return event.type !== 'rejected';
}
