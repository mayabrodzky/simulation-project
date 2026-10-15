/**
 * Canvas renderer for the isometric lab.
 *
 * The renderer is a pure consumer of state. It reads a RenderView and draws it;
 * it never changes the world, never decides anything, and never touches a
 * panel. That is what makes Phase 4's two-labs-side-by-side cheap — two views,
 * one draw function, called twice.
 *
 * The drawing code was moved here verbatim and left untyped for two commits, so
 * that the move and the palette extraction could each be checked by comparing
 * screenshots. Both of the bugs that cost time during those commits — a missing
 * lastTime that produced NaN coordinates, and a local palette array shadowed by
 * the imported one — are compile errors now rather than things that silently
 * draw nothing.
 */
import type { Camera, Equipment, Layout, Prop, Staff, StaffId, Wall } from '../domain/types';
import { palette } from './palette';

/** Everything the renderer is allowed to see. */
export interface RenderView {
  camera: Camera;
  layout: Layout;
  staff: Staff[];
  equipment: Equipment[];
  props: Prop[];
  walls: Wall[];
  /** Always empty today: a stub for building occupants that was never built. */
  staticPersonnel: { x: number; y: number }[];
  /** Simulation clock, minutes past midnight. Read by the HUD. */
  state: { time: number };
  /**
   * How far through its current step each working person is, 0–1.
   *
   * Supplied rather than derived, so the renderer holds no opinion about how
   * work is represented. When work becomes an entity of its own, nothing here
   * changes.
   */
  progressByStaff: Record<StaffId, number>;
  /** Who is free and idle. Cosmetic: they bob on the spot. */
  unoccupiedStaffIds: StaffId[];
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

/**
 * One drawable thing, tagged so the scene can dispatch on it after z-sorting.
 *
 * Note the prop case. The scene builds its list with `{ ...prop, type: 'prop' }`,
 * which overwrites the prop's own kind — a Prop is already tagged 'desk',
 * 'shelf', 'plant', 'coffee' or 'door'. So by the time drawProp sees it, that
 * information is gone, and its shelf and icon-only branches are unreachable:
 * every prop is drawn as a desk with its icon on top. Typing this is what
 * surfaced it; `Prop & { type: 'prop' }` collapses to never.
 *
 * Preserved deliberately, because Phase 1 changes no behaviour. Fixing it is a
 * one-line change that alters what is on screen, so it belongs with the visual
 * work in Phase 2.5.
 */
type SceneEntity =
  | (Equipment & { type: 'equipment'; zIndex: number })
  | (Staff & { type: 'staff'; zIndex: number })
  | (Omit<Prop, 'type'> & { type: 'prop'; zIndex: number })
  | (Wall & { type: 'wall'; zIndex: number })
  | { type: 'static_person'; zIndex: number; x: number; y: number };

/** What drawProp actually receives: a prop whose own kind has been overwritten. */
type DrawableProp = Omit<Prop, 'type'> & { type: string };

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('renderer: 2d canvas context is unavailable');

  let current: RenderView | null = null;

  /**
   * Fails loudly rather than reading undefined off a missing view.
   *
   * The moved drawing code still refers to this.camera, this.labFloor and so
   * on. Keeping those as getters is what let 350 lines move without being
   * edited, and the view holds live references rather than copies, so the hover
   * hit-test still sees the camera as it is now rather than as it was last
   * frame.
   */
  const v = (): RenderView => {
    if (!current) throw new Error('renderer: render(view) must be called before drawing');
    return current;
  };

  const R = {
    canvas,
    ctx: context,
    width: 0,
    height: 0,

    get camera() {
      return v().camera;
    },
    get state() {
      return v().state;
    },
    get progressByStaff() {
      return v().progressByStaff;
    },
    get unoccupiedStaffIds() {
      return v().unoccupiedStaffIds;
    },
    /** drawStaff's idle bob reads this; it used to live on the Lab object. */
    get lastTime() {
      return v().nowMs;
    },
    get staff() {
      return v().staff;
    },
    get equipment() {
      return v().equipment;
    },
    get props() {
      return v().props;
    },
    get walls() {
      return v().walls;
    },
    get staticPersonnel() {
      return v().staticPersonnel;
    },
    get hoveredEntity() {
      return v().hoveredEntity;
    },
    get highlightedStaffIds() {
      return v().highlightedStaffIds;
    },
    get gridWidth() {
      return v().layout.gridWidth;
    },
    get gridHeight() {
      return v().layout.gridHeight;
    },
    get tileSize() {
      return v().layout.tileSize;
    },
    get tileHeight() {
      return v().layout.tileHeight;
    },
    get labFloor() {
      return v().layout.labFloor;
    },
    get office1() {
      return v().layout.office1;
    },
    get office2() {
      return v().layout.office2;
    },

    toIso(x: number, y: number) {
      const isoX = ((x - y) * this.tileSize) / 2;
      const isoY = ((x + y) * this.tileSize) / 4;
      return { x: isoX, y: isoY };
    },

    getScreenCoords(gridX: number, gridY: number) {
      const iso = this.toIso(gridX, gridY);
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

    drawIsoBox(
      x: number,
      y: number,
      w: number,
      h: number,
      z: number,
      topColor: string,
      sideColor1: string = palette.isoBoxDefault.side1,
      sideColor2: string = palette.isoBoxDefault.side2,
    ) {
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

    drawIsoWall(x1: number, y1: number, x2: number, y2: number, z: number, color: string) {
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
      _bg.addColorStop(0, palette.background.top);
      _bg.addColorStop(1, palette.background.bottom);
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
      this.drawIsoBox(
        f.x,
        f.y,
        f.w,
        f.h,
        this.tileHeight,
        palette.floor.lab.top,
        palette.floor.lab.side1,
        palette.floor.lab.side2,
      );
      this.ctx.globalAlpha = palette.floor.gridAlpha;
      this.ctx.strokeStyle = palette.floor.gridLine;
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
      const office = palette.floor.office;
      this.drawIsoBox(
        o1.x,
        o1.y,
        o1.w,
        o1.h,
        this.tileHeight,
        office.top,
        office.side1,
        office.side2,
      );
      this.drawIsoBox(
        o2.x,
        o2.y,
        o2.w,
        o2.h,
        this.tileHeight,
        office.top,
        office.side1,
        office.side2,
      );
      this.drawIsoBox(
        f.x + f.w,
        f.y,
        o1.x - (f.x + f.w),
        f.h,
        this.tileHeight,
        palette.floor.corridor.top,
        palette.floor.corridor.side1,
        palette.floor.corridor.side2,
      );
      this.drawIsoBox(
        f.x,
        f.y + f.h,
        f.w,
        o2.y - (f.y + f.h),
        this.tileHeight,
        palette.floor.corridor.top,
        palette.floor.corridor.side1,
        palette.floor.corridor.side2,
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
      ].sort((a, b) => a.zIndex - b.zIndex) as SceneEntity[];
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
          this.drawIsoWall(entity.x1, entity.y1, entity.x2, entity.y2, entity.height, palette.wall);
        else if (entity.type === 'static_person') this.drawStaticPerson(entity);
      });
      if (this.hoveredEntity) {
        this.drawHoverLabel(this.hoveredEntity);
      }
      this.ctx.restore();
      this.drawHUD();
    },

    drawExterior() {},

    drawEquipment(eq: Equipment) {
      const eqHeight = 16;
      const bodies = palette.equipment.bodies;
      const colors = eq.inUse
        ? palette.equipment.inUse
        : bodies[eq.id % bodies.length] || bodies[0];
      const isoTop = this.toIso(eq.x, eq.y);
      if (eq.inUse) {
        this.ctx.save();
        this.ctx.shadowColor = palette.equipment.inUseGlow;
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
        this.ctx.fillStyle = eq.inUse
          ? palette.equipment.label.inUse
          : palette.equipment.label.idle;
        this.ctx.font = 'bold 9px Inter';
        this.ctx.fillText(eq.name, isoTop.x, isoTop.y + this.tileSize / 4 + 2);
      }
    },

    drawProp(prop: DrawableProp) {
      let propHeight = 12;
      let topColor: string = palette.prop.desk.top;
      let side1: string = palette.prop.desk.side1;
      let side2: string = palette.prop.desk.side2;
      if (prop.type === 'shelf') {
        propHeight = 25;
        topColor = palette.prop.shelf.top;
        side1 = palette.prop.shelf.side1;
        side2 = palette.prop.shelf.side2;
      } else if (['plant', 'coffee', 'door'].includes(prop.type)) {
        const iso = this.toIso(prop.x, prop.y);
        this.ctx.font = `20px Arial`;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(prop.icon, iso.x, iso.y - 10);
        return;
      }
      this.drawIsoBox(
        prop.x - (prop.w ?? 1) / 2 + 0.5,
        prop.y - (prop.h ?? 1) / 2 + 0.5,
        prop.w ?? 1,
        prop.h ?? 1,
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

    drawStaff(person: Staff) {
      const iso = this.toIso(person.x, person.y);
      const size = 14;
      const bob = this.unoccupiedStaffIds.includes(person.id)
        ? Math.sin(this.lastTime / 200 + person.id) * 2
        : 0;
      const y = iso.y - bob;
      const stateColor: Record<string, string> = {
        ...palette.staff.state,
        idle: person.color,
      };
      const hairColors = palette.staff.hair;
      this.ctx.fillStyle = palette.staff.groundShadow;
      this.ctx.beginPath();
      this.ctx.ellipse(iso.x, iso.y + size * 0.25, size * 0.65, size * 0.28, 0, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = palette.staff.outline;
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
      this.ctx.fillStyle = palette.staff.skin;
      this.ctx.fillRect(iso.x - size * 0.16, y - size * 1.2, size * 0.32, size * 0.24);
      this.ctx.beginPath();
      this.ctx.arc(iso.x, y - size * 1.58, size * 0.52, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.fillStyle = hairColors[person.id % hairColors.length] ?? palette.staff.outline;
      this.ctx.beginPath();
      this.ctx.arc(iso.x, y - size * 1.78, size * 0.42, Math.PI, 0);
      this.ctx.fill();
      this.ctx.fillStyle = palette.staff.outline;
      this.ctx.beginPath();
      this.ctx.arc(iso.x - size * 0.18, y - size * 1.58, size * 0.09, 0, Math.PI * 2);
      this.ctx.arc(iso.x + size * 0.18, y - size * 1.58, size * 0.09, 0, Math.PI * 2);
      this.ctx.fill();
      const progress = this.progressByStaff[person.id];
      if (progress !== undefined) {
        this.ctx.fillStyle = palette.staff.progress.track;
        this.ctx.fillRect(iso.x - size, y - size * 2.5, size * 2, 4);
        this.ctx.fillStyle = palette.staff.progress.fill;
        this.ctx.fillRect(iso.x - size, y - size * 2.5, size * 2 * progress, 4);
      }
      if (this.highlightedStaffIds.includes(person.id)) {
        this.ctx.strokeStyle = palette.staff.qualifiedRing;
        this.ctx.lineWidth = 2.5;
        this.ctx.beginPath();
        this.ctx.arc(iso.x, y - size * 0.4, size * 1.25, 0, Math.PI * 2);
        this.ctx.stroke();
      }
      if (this.camera.zoom > 0.8) {
        const firstName = person.name.split(' ')[0] ?? person.name;
        this.ctx.font = 'bold 9px Inter';
        const nameW = this.ctx.measureText(firstName).width + 10;
        this.ctx.fillStyle = palette.staff.namePlate;
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

    drawStaticPerson(_person: { x: number; y: number }) {},

    drawHoverLabel(entity: Staff | Equipment) {
      const iso = this.toIso(entity.x, entity.y);
      const text = entity.name;
      this.ctx.font = `bold 12px Inter`;
      const textMetrics = this.ctx.measureText(text);
      const width = textMetrics.width + 16;
      const height = 24;
      const x = iso.x - width / 2;
      const y = iso.y - 50;
      this.ctx.fillStyle = palette.hoverLabel;
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
      const hud = isNight ? palette.hud.night : palette.hud.day;
      this.ctx.fillStyle = hud.fill;
      this.ctx.strokeStyle = hud.border;
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      if (this.ctx.roundRect) {
        this.ctx.roundRect(10, 10, 115, 36, 8);
      } else {
        this.ctx.rect(10, 10, 115, 36);
      }
      this.ctx.fill();
      this.ctx.stroke();
      this.ctx.fillStyle = hud.text;
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
    render(view: RenderView) {
      current = view;
      R.render();
    },
    getScreenCoords(gridX: number, gridY: number) {
      if (!current) return { x: 0, y: 0 };
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
