// @ts-nocheck
/**
 * Canvas renderer for the isometric lab.
 *
 * The drawing code is moved here byte for byte from the simulation object; not
 * one colour or coordinate is changed in this commit, because this is the
 * highest visual-risk step of the refactor and a verbatim move is the only
 * version that can be checked by comparing screenshots. The colours are pulled
 * out into a palette in the commit that follows this one.
 *
 * The renderer is a pure consumer of state. It reads a RenderView and draws it;
 * it never changes the world, never decides anything, and never touches a
 * panel. That is what makes Phase 4's two-labs-side-by-side cheap — two views,
 * one draw function, called twice.
 *
 * It carries @ts-nocheck for the same reason the legacy file does: typing 350
 * lines of untouched drawing code in the same commit that moves it would make
 * the move impossible to review. It is typed when it is split up and the
 * entity types are settled.
 */
import type { Camera, Equipment, Layout, Prop, Staff, StaffId, Wall } from '../domain/types';

/** Everything the renderer is allowed to see. */
export interface RenderView {
  camera: Camera;
  layout: Layout;
  staff: Staff[];
  equipment: Equipment[];
  props: Prop[];
  walls: Wall[];
  staticPersonnel: unknown[];
  /** Simulation clock, minutes past midnight. Read by the HUD. */
  state: { time: number };
  /**
   * Animation clock in milliseconds, used only for cosmetic motion such as the
   * idle bob. Passed in rather than read from performance.now() so that drawing
   * stays a pure function of the view — which is what lets Phase 4 render a
   * paused or replayed world without it animating on its own.
   */
  nowMs: number;
  hoveredEntity: Staff | Equipment | null;
  highlightedStaffIds: StaffId[];
}

export interface Renderer {
  /** Match the drawing buffer to the element's CSS size. */
  resize(): void;
  render(view: RenderView): void;
  /** Grid position to screen pixels, for hit-testing. */
  getScreenCoords(gridX: number, gridY: number): { x: number; y: number };
  readonly width: number;
  readonly height: number;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  /**
   * The moved methods still read this.ctx, this.camera, this.labFloor and so
   * on. Rather than edit 350 lines of drawing code — which would have made a
   * verbatim move unverifiable — those names are kept as getters that read
   * through to the current view. The view holds live references, so there is
   * no per-frame copying and no chance of the renderer drawing stale state.
   */
  const R = {
    canvas,
    ctx: canvas.getContext('2d'),
    width: 0,
    height: 0,
    view: null,

    get camera() {
      return this.view.camera;
    },
    get state() {
      return this.view.state;
    },
    /** drawStaff's idle bob reads this; it used to live on the Lab object. */
    get lastTime() {
      return this.view.nowMs;
    },
    get staff() {
      return this.view.staff;
    },
    get equipment() {
      return this.view.equipment;
    },
    get props() {
      return this.view.props;
    },
    get walls() {
      return this.view.walls;
    },
    get staticPersonnel() {
      return this.view.staticPersonnel;
    },
    get hoveredEntity() {
      return this.view.hoveredEntity;
    },
    get highlightedStaffIds() {
      return this.view.highlightedStaffIds;
    },
    get gridWidth() {
      return this.view.layout.gridWidth;
    },
    get gridHeight() {
      return this.view.layout.gridHeight;
    },
    get tileSize() {
      return this.view.layout.tileSize;
    },
    get tileHeight() {
      return this.view.layout.tileHeight;
    },
    get labFloor() {
      return this.view.layout.labFloor;
    },
    get office1() {
      return this.view.layout.office1;
    },
    get office2() {
      return this.view.layout.office2;
    },

    toIso(x, y) {
      const isoX = ((x - y) * this.tileSize) / 2;
      const isoY = ((x + y) * this.tileSize) / 4;
      return { x: isoX, y: isoY };
    },

    getScreenCoords(gridX, gridY) {
      let iso = this.toIso(gridX, gridY);
      const screenX =
        iso.x * this.camera.zoom +
        this.width / 2 +
        this.camera.x -
        ((this.gridWidth * this.tileSize) / 4) * this.camera.zoom;
      const screenY =
        iso.y * this.camera.zoom +
        this.height / 2 +
        this.camera.y -
        150 -
        ((this.gridHeight * this.tileSize) / 8) * this.camera.zoom;
      return { x: screenX, y: screenY };
    },

    drawIsoBox(x, y, w, h, z, topColor, sideColor1 = '#a1a1a1', sideColor2 = '#8a8a8a') {
      const zc = z;
      const p1 = this.toIso(x, y);
      const p2 = this.toIso(x + w, y);
      const p3 = this.toIso(x + w, y + h);
      const p4 = this.toIso(x, y + h);
      this.ctx.fillStyle = sideColor1;
      this.ctx.beginPath();
      this.ctx.moveTo(p4.x, p4.y);
      this.ctx.lineTo(p3.x, p3.y);
      this.ctx.lineTo(p3.x, p3.y - zc);
      this.ctx.lineTo(p4.x, p4.y - zc);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = sideColor2;
      this.ctx.beginPath();
      this.ctx.moveTo(p2.x, p2.y);
      this.ctx.lineTo(p3.x, p3.y);
      this.ctx.lineTo(p3.x, p3.y - zc);
      this.ctx.lineTo(p2.x, p2.y - zc);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.fillStyle = topColor;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.lineTo(p3.x, p3.y);
      this.ctx.lineTo(p4.x, p4.y);
      this.ctx.closePath();
      this.ctx.fill();
    },

    drawIsoWall(x1, y1, x2, y2, z, color) {
      const zc = z;
      const p1 = this.toIso(x1, y1);
      const p2 = this.toIso(x2, y2);
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.moveTo(p1.x, p1.y);
      this.ctx.lineTo(p2.x, p2.y);
      this.ctx.lineTo(p2.x, p2.y - zc);
      this.ctx.lineTo(p1.x, p1.y - zc);
      this.ctx.closePath();
      this.ctx.fill();
    },

    render() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      const _bg = this.ctx.createLinearGradient(0, 0, 0, this.height);
      _bg.addColorStop(0, '#1a2a40');
      _bg.addColorStop(1, '#0a1020');
      this.ctx.fillStyle = _bg;
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.ctx.save();
      this.ctx.translate(this.width / 2 + this.camera.x, this.height / 2 + this.camera.y - 150);
      this.ctx.scale(this.camera.zoom, this.camera.zoom);
      this.ctx.translate(
        (-this.gridWidth * this.tileSize) / 4,
        (-this.gridHeight * this.tileSize) / 8,
      );
      this.drawExterior();
      const f = this.labFloor;
      const o1 = this.office1;
      const o2 = this.office2;
      this.drawIsoBox(f.x, f.y, f.w, f.h, this.tileHeight, '#ddd5c3', '#b8a898', '#a89888');
      this.ctx.globalAlpha = 0.15;
      this.ctx.strokeStyle = '#8B7355';
      this.ctx.lineWidth = 0.8;
      for (let i = 0; i < f.w; i++) {
        for (let j = 0; j < f.h; j++) {
          const p1 = this.toIso(f.x + i, f.y + j);
          const p2 = this.toIso(f.x + i + 1, f.y + j);
          const p3 = this.toIso(f.x + i + 1, f.y + j + 1);
          const p4 = this.toIso(f.x + i, f.y + j + 1);
          this.ctx.beginPath();
          this.ctx.moveTo(p1.x, p1.y);
          this.ctx.lineTo(p2.x, p2.y);
          this.ctx.lineTo(p3.x, p3.y);
          this.ctx.lineTo(p4.x, p4.y);
          this.ctx.closePath();
          this.ctx.stroke();
        }
      }
      this.ctx.globalAlpha = 1;
      this.drawIsoBox(o1.x, o1.y, o1.w, o1.h, this.tileHeight, '#1e3f7a', '#152d6e', '#0f2057');
      this.drawIsoBox(o2.x, o2.y, o2.w, o2.h, this.tileHeight, '#1e3f7a', '#152d6e', '#0f2057');
      this.drawIsoBox(
        f.x + f.w,
        f.y,
        o1.x - (f.x + f.w),
        f.h,
        this.tileHeight,
        '#c8c0b0',
        '#a0988a',
        '#908878',
      );
      this.drawIsoBox(
        f.x,
        f.y + f.h,
        f.w,
        o2.y - (f.y + f.h),
        this.tileHeight,
        '#c8c0b0',
        '#a0988a',
        '#908878',
      );
      const entities = [
        ...this.equipment.map((e) => ({ ...e, type: 'equipment', zIndex: e.x + e.y })),
        ...this.staff.map((s) => ({ ...s, type: 'staff', zIndex: s.x + s.y + 0.1 })),
        ...this.props.map((p) => ({ ...p, type: 'prop', zIndex: p.x + p.y })),
        ...this.walls.map((w) => ({
          ...w,
          type: 'wall',
          zIndex: Math.min(w.x1 + w.y1, w.x2 + w.y2) - 0.1,
        })),
        ...this.staticPersonnel.map((p) => ({ ...p, type: 'static_person', zIndex: p.x + p.y })),
      ].sort((a, b) => a.zIndex - b.zIndex);
      entities.forEach((entity) => {
        if (entity.type === 'equipment') this.drawEquipment(entity);
        else if (
          entity.type === 'staff' &&
          entity.state !== 'off' &&
          entity.state !== 'vacation' &&
          entity.state !== 'sick'
        )
          this.drawStaff(entity);
        else if (entity.type === 'prop') this.drawProp(entity);
        else if (entity.type === 'wall')
          this.drawIsoWall(entity.x1, entity.y1, entity.x2, entity.y2, entity.height, '#c5bdb0');
        else if (entity.type === 'static_person') this.drawStaticPerson(entity);
      });
      if (this.hoveredEntity) {
        this.drawHoverLabel(this.hoveredEntity);
      }
      this.ctx.restore();
      this.drawHUD();
    },

    drawExterior() {},

    drawEquipment(eq) {
      const eqHeight = 16;
      const palette = [
        ['#7c3aed', '#5b21b6', '#4c1d95'],
        ['#0891b2', '#0e7490', '#164e63'],
        ['#059669', '#047857', '#065f46'],
        ['#d97706', '#b45309', '#92400e'],
        ['#2563eb', '#1d4ed8', '#1e40af'],
        ['#dc2626', '#b91c1c', '#991b1b'],
        ['#0d9488', '#0f766e', '#115e59'],
        ['#1d4ed8', '#1e40af', '#1e3a8a'],
        ['#65a30d', '#4d7c0f', '#3f6212'],
      ];
      const colors = eq.inUse
        ? ['#6ee7b7', '#34d399', '#10b981']
        : palette[eq.id % palette.length] || palette[0];
      const isoTop = this.toIso(eq.x, eq.y);
      if (eq.inUse) {
        this.ctx.save();
        this.ctx.shadowColor = '#6ee7b7';
        this.ctx.shadowBlur = 15;
        this.drawIsoBox(
          eq.x - 0.42,
          eq.y - 0.42,
          0.84,
          0.84,
          eqHeight,
          colors[0],
          colors[1],
          colors[2],
        );
        this.ctx.restore();
      } else {
        this.drawIsoBox(
          eq.x - 0.42,
          eq.y - 0.42,
          0.84,
          0.84,
          eqHeight,
          colors[0],
          colors[1],
          colors[2],
        );
      }
      this.ctx.font = '18px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(eq.icon, isoTop.x, isoTop.y - eqHeight * 0.75);
      if (this.camera.zoom > 0.75) {
        this.ctx.fillStyle = eq.inUse ? '#ecfdf5' : 'rgba(255,255,255,0.92)';
        this.ctx.font = 'bold 9px Inter';
        this.ctx.fillText(eq.name, isoTop.x, isoTop.y + this.tileSize / 4 + 2);
      }
    },

    drawProp(prop) {
      let propHeight = 12,
        topColor = '#a16207',
        side1 = '#854d0e',
        side2 = '#713f12';
      if (prop.type === 'shelf') {
        propHeight = 25;
        topColor = '#9ca3af';
        side1 = '#475569';
        side2 = '#334155';
      } else if (['plant', 'coffee', 'door'].includes(prop.type)) {
        const iso = this.toIso(prop.x, prop.y);
        this.ctx.font = `20px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(prop.icon, iso.x, iso.y - 10);
        return;
      }
      this.drawIsoBox(
        prop.x - prop.w / 2 + 0.5,
        prop.y - prop.h / 2 + 0.5,
        prop.w,
        prop.h,
        propHeight,
        topColor,
        side1,
        side2,
      );
      if (prop.icon) {
        const isoTop = this.toIso(prop.x + 0.5, prop.y + 0.5);
        this.ctx.font = `20px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(prop.icon, isoTop.x, isoTop.y - propHeight * 0.7);
      }
    },

    drawStaff(person) {
      const iso = this.toIso(person.x, person.y);
      const size = 14;
      const bob =
        person.state === 'idle' && !person.activeTask
          ? Math.sin(this.lastTime / 200 + person.id) * 2
          : 0;
      const y = iso.y - bob;
      const stateColor = {
        working: '#10b981',
        idle: person.color,
        break: '#f59e0b',
        sick: '#a78bfa',
        vacation: '#06b6d4',
        off: '#94a3b8',
      };
      const hairColors = ['#1e293b', '#92400e', '#7c3aed', '#0c4a6e', '#374151'];
      this.ctx.fillStyle = 'rgba(0,0,0,0.22)';
      this.ctx.beginPath();
      this.ctx.ellipse(iso.x, iso.y + size * 0.25, size * 0.65, size * 0.28, 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = '#1e293b';
      this.ctx.fillRect(iso.x - size * 0.38, y + size * 0.05, size * 0.28, size * 0.7);
      this.ctx.fillRect(iso.x + size * 0.1, y + size * 0.05, size * 0.28, size * 0.7);
      this.ctx.fillStyle = stateColor[person.state] || person.color;
      this.ctx.beginPath();
      if (this.ctx.roundRect) {
        this.ctx.roundRect(iso.x - size * 0.65, y - size * 1.0, size * 1.3, size * 1.1, 4);
      } else {
        this.ctx.rect(iso.x - size * 0.65, y - size * 1.0, size * 1.3, size * 1.1);
      }
      this.ctx.fill();
      this.ctx.fillStyle = '#FDDBB4';
      this.ctx.fillRect(iso.x - size * 0.16, y - size * 1.2, size * 0.32, size * 0.24);
      this.ctx.beginPath();
      this.ctx.arc(iso.x, y - size * 1.58, size * 0.52, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = hairColors[person.id % hairColors.length];
      this.ctx.beginPath();
      this.ctx.arc(iso.x, y - size * 1.78, size * 0.42, Math.PI, 0);
      this.ctx.fill();
      this.ctx.fillStyle = '#1e293b';
      this.ctx.beginPath();
      this.ctx.arc(iso.x - size * 0.18, y - size * 1.58, size * 0.09, 0, Math.PI * 2);
      this.ctx.arc(iso.x + size * 0.18, y - size * 1.58, size * 0.09, 0, Math.PI * 2);
      this.ctx.fill();
      if (person.activeTask && person.state === 'working') {
        const isT = person.activeTask.type === 'training';
        const dur = isT
          ? person.activeTask.duration
          : person.activeTask.equipmentSequence &&
              person.activeTask.equipmentSequence[person.taskStep]
            ? person.activeTask.equipmentSequence[person.taskStep].duration
            : 0;
        const progress = dur > 0 ? Math.max(0, Math.min(1, 1 - person.taskTimer / dur)) : 0;
        this.ctx.fillStyle = 'rgba(0,0,0,0.35)';
        this.ctx.fillRect(iso.x - size, y - size * 2.5, size * 2, 4);
        this.ctx.fillStyle = '#818cf8';
        this.ctx.fillRect(iso.x - size, y - size * 2.5, size * 2 * progress, 4);
      }
      if (this.highlightedStaffIds.includes(person.id)) {
        this.ctx.strokeStyle = 'rgba(16,185,129,0.9)';
        this.ctx.lineWidth = 2.5;
        this.ctx.beginPath();
        this.ctx.arc(iso.x, y - size * 0.4, size * 1.25, 0, Math.PI * 2);
        this.ctx.stroke();
      }
      if (this.camera.zoom > 0.8) {
        const firstName = person.name.split(' ')[0];
        this.ctx.font = 'bold 9px Inter';
        const nameW = this.ctx.measureText(firstName).width + 10;
        this.ctx.fillStyle = 'rgba(15,23,42,0.7)';
        this.ctx.beginPath();
        if (this.ctx.roundRect) {
          this.ctx.roundRect(iso.x - nameW / 2, y + size * 0.85, nameW, 13, 3);
        } else {
          this.ctx.rect(iso.x - nameW / 2, y + size * 0.85, nameW, 13);
        }
        this.ctx.fill();
        this.ctx.fillStyle = 'white';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(firstName, iso.x, y + size * 0.85 + 9);
      }
    },

    drawStaticPerson(person) {},

    drawHoverLabel(entity) {
      const iso = this.toIso(entity.x, entity.y);
      const text = entity.name;
      this.ctx.font = `bold 12px Inter`;
      const textMetrics = this.ctx.measureText(text);
      const width = textMetrics.width + 16;
      const height = 24;
      const x = iso.x - width / 2;
      const y = iso.y - 50;
      this.ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      this.ctx.fillRect(x, y, width, height);
      this.ctx.fillStyle = 'white';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(text, iso.x, y + height / 2);
    },

    drawHUD() {
      const h = Math.floor(this.state.time / 60) % 24;
      const m = Math.floor(this.state.time % 60);
      const timeStr = h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
      const isNight = h < 6 || h >= 21;
      this.ctx.fillStyle = isNight ? 'rgba(15,23,42,0.88)' : 'rgba(255,255,255,0.88)';
      this.ctx.strokeStyle = isNight ? 'rgba(99,102,241,0.5)' : 'rgba(59,130,246,0.3)';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      if (this.ctx.roundRect) {
        this.ctx.roundRect(10, 10, 115, 36, 8);
      } else {
        this.ctx.rect(10, 10, 115, 36);
      }
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.fillStyle = isNight ? '#c7d2fe' : '#1e293b';
      this.ctx.font = 'bold 14px Inter';
      this.ctx.textAlign = 'left';
      this.ctx.fillText((isNight ? '🌙' : '☀️') + ' ' + timeStr, 20, 33);
    },
  };

  return {
    resize() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;
      R.width = rect.width;
      R.height = rect.height;
    },
    render(view) {
      R.view = view;
      R.render();
    },
    getScreenCoords(gridX, gridY) {
      if (!R.view) return { x: 0, y: 0 };
      return R.getScreenCoords(gridX, gridY);
    },
    get width() {
      return R.width;
    },
    get height() {
      return R.height;
    },
  };
}
