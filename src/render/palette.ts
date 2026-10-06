/**
 * Every colour the canvas draws, named.
 *
 * These were scattered as hex literals through the drawing code, where the
 * same value appeared in several places with nothing to say it was the same
 * decision — so a change to "the floor colour" meant finding every copy. The
 * canvas has its own palette because it cannot read CSS custom properties; the
 * two are kept deliberately consistent where they overlap (the staff state
 * colours here match the badge colours in lab.css).
 *
 * Phase 2.5 reworks the visual language, and this file is where the lab's half
 * of that happens.
 */

export const palette = {
  /** The dark void behind the building. */
  background: { top: '#1a2a40', bottom: '#0a1020' },

  /** Floors and the faint tile grid drawn over the lab. */
  floor: {
    lab: { top: '#ddd5c3', side1: '#b8a898', side2: '#a89888' },
    office: { top: '#1e3f7a', side1: '#152d6e', side2: '#0f2057' },
    corridor: { top: '#c8c0b0', side1: '#a0988a', side2: '#908878' },
    gridLine: '#8B7355',
    gridAlpha: 0.15,
  },

  wall: '#c5bdb0',

  /** Fallback sides for drawIsoBox when a caller passes only a top colour. */
  isoBoxDefault: { side1: '#a1a1a1', side2: '#8a8a8a' },

  equipment: {
    /**
     * One triple per machine, indexed by position in the scenario's equipment
     * list, so each is visually distinguishable at a glance.
     */
    bodies: [
      ['#7c3aed', '#5b21b6', '#4c1d95'],
      ['#0891b2', '#0e7490', '#164e63'],
      ['#059669', '#047857', '#065f46'],
      ['#d97706', '#b45309', '#92400e'],
      ['#2563eb', '#1d4ed8', '#1e40af'],
      ['#dc2626', '#b91c1c', '#991b1b'],
      ['#0d9488', '#0f766e', '#115e59'],
      ['#1d4ed8', '#1e40af', '#1e3a8a'],
      ['#65a30d', '#4d7c0f', '#3f6212'],
    ] as const,
    /** Replaces the body colour while a machine is being used. */
    inUse: ['#6ee7b7', '#34d399', '#10b981'] as const,
    inUseGlow: '#6ee7b7',
    label: { inUse: '#ecfdf5', idle: 'rgba(255,255,255,0.92)' },
  },

  prop: {
    desk: { top: '#a16207', side1: '#854d0e', side2: '#713f12' },
    shelf: { top: '#9ca3af', side1: '#475569', side2: '#334155' },
  },

  staff: {
    /** Matches the badge colours in lab.css. 'idle' uses the person's own hue. */
    state: {
      working: '#10b981',
      break: '#f59e0b',
      sick: '#a78bfa',
      vacation: '#06b6d4',
      off: '#94a3b8',
    } as Record<string, string>,
    hair: ['#1e293b', '#92400e', '#7c3aed', '#0c4a6e', '#374151'] as const,
    skin: '#FDDBB4',
    /** Legs and eyes. */
    outline: '#1e293b',
    groundShadow: 'rgba(0,0,0,0.22)',
    namePlate: 'rgba(15,23,42,0.7)',
    /** Ring drawn around staff qualified for a hovered task. */
    qualifiedRing: 'rgba(16,185,129,0.9)',
    progress: { track: 'rgba(0,0,0,0.35)', fill: '#818cf8' },
  },

  hoverLabel: 'rgba(0, 0, 0, 0.75)',

  /** The clock pill, which inverts between day and night. */
  hud: {
    day: { fill: 'rgba(255,255,255,0.88)', border: 'rgba(59,130,246,0.3)', text: '#1e293b' },
    night: { fill: 'rgba(15,23,42,0.88)', border: 'rgba(99,102,241,0.5)', text: '#c7d2fe' },
  },
} as const;
