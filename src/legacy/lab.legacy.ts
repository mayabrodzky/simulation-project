// @ts-nocheck
/**
 * The view layer: panels, modals, sandbox mode and the frame loop.
 *
 * This began as the entire application, inline in lab-simulation.html. Over
 * Phase 1 the simulation moved to src/engine, the drawing to src/render, the
 * lab's data to src/scenarios and safe rendering to src/ui, leaving this as
 * what is genuinely view code: it reads the world, renders it, and turns
 * clicks into commands. It holds no rules.
 *
 * It still carries @ts-nocheck and lives under legacy/ because it has not been
 * split into typed modules yet — that is the next piece of work, and it is
 * deliberately not part of Phase 1.
 */
import '../styles/base.css';
import '../styles/lab.css';
import { chemistryLab, scenarioFromBusinessProfile } from '../scenarios';
import {
  applyCommand,
  cloneWorld,
  countTraining,
  createWorld,
  describeAssignment,
  formatDuration,
  isPanelAffecting,
  isQualified,
  isUnoccupied,
  listActiveWork,
  listUrgentWork,
  progressByStaff,
  staffLoadPercent,
  tick,
  unoccupiedStaffIds,
  urgentTimeLeft,
} from '../engine';
import { createRenderer } from '../render/renderer';
import { installActions, installEscape, installHover } from '../ui/actions';
import { appendHtml, html, setHtml, setHtmlById } from '../ui/dom';

/**
 * How often the sidebar is rebuilt, in milliseconds. The canvas is redrawn
 * every frame; the panels are not. Everything in them that changes
 * continuously is a countdown or a progress bar, and four updates a second is
 * indistinguishable from sixty.
 */
const PANEL_INTERVAL_MS = 250;

const Lab = {
  scenario: chemistryLab,
  renderer: null,
  seed: 1,
  lastPanelTick: 0,
  canvas: null,
  timeOverlay: null,

  /** The simulation. Everything below that looks like state reads through to it. */
  world: null,

  // View state: how this lab is being looked at, not what is true of it. Kept
  // apart from the world so Phase 4 can show two worlds with two cameras.
  camera: { x: 0, y: 0, zoom: 1 },
  isSandboxMode: false,
  liveWorldBackup: null,
  selectedStaff: null,
  activeEmergencyTask: null,
  hoveredEntity: null,
  highlightedStaffIds: [],
  sandboxSessionHistory: [],
  currentSandboxSession: null,

  // Read-through aliases, so the panel and modal code that still says
  // this.staff or this.equipment keeps working while it is migrated. They are
  // getters, not copies: there is one source of truth and it is the world.
  get staff() {
    return this.world.staff;
  },
  get equipment() {
    return this.world.equipment;
  },
  get tasks() {
    return this.world.tasks;
  },
  get emergencyQueue() {
    return this.world.emergencies;
  },
  get equipmentCatalog() {
    return this.world.catalog;
  },
  get props() {
    return this.world.props;
  },
  get walls() {
    return this.world.walls;
  },
  get staticPersonnel() {
    return [];
  },
  get labFloor() {
    return this.world.layout.labFloor;
  },

  init() {
    // Seeded so a run can be reproduced: ?seed=123 replays it exactly.
    // Without the parameter the seed is taken from the clock, which keeps
    // today's behaviour of a different lab on every load.
    const seedParam = new URLSearchParams(window.location.search).get('seed');
    this.seed = seedParam !== null && seedParam !== '' ? Number(seedParam) : Date.now();
    if (!Number.isFinite(this.seed)) this.seed = Date.now();
    console.log('Simulation seed:', this.seed);
    this.scenario = this.businessProfile
      ? scenarioFromBusinessProfile(this.businessProfile)
      : chemistryLab;

    // The clock still starts from the real time of day, which is why the lab
    // renders in daylight or at night depending on when it is opened. The
    // engine takes it as a parameter, so a fixed start is now one argument
    // away when Phase 2 wants comparable runs.
    const now = new Date();
    const startMinutes = now.getHours() * 60 + now.getMinutes();
    this.world = createWorld(this.scenario, this.seed, startMinutes);

    this.camera = { ...this.scenario.layout.initialCamera };
    this.canvas = document.getElementById('gameCanvas');
    this.timeOverlay = document.getElementById('timeOverlay');
    this.renderer = createRenderer(this.canvas);
    this.renderer.resize();
    window.addEventListener('resize', () => this.renderer.resize());
    this.setupEventHandlers();
    this.lastTime = performance.now();
    this.gameLoop();
    this.updateAllPanels();
    this.updateSessionHistoryPanel();
  },
  updateAllPanels() {
    this.updateStaffPanel();
    this.updateEquipmentPanel();
    this.updateTaskListPanel();
    this.updateStatusCounts();
    this.updateEmergencyListPanel();
    this.updateOngoingTasksPanel();
  },
  /** The view the renderer is allowed to see. Live references, not copies. */
  buildRenderView() {
    return {
      camera: this.camera,
      layout: this.world.layout,
      staff: this.world.staff,
      equipment: this.world.equipment,
      props: this.world.props,
      walls: this.world.walls,
      staticPersonnel: [],
      state: { time: this.world.minutes },
      progressByStaff: progressByStaff(this.world),
      unoccupiedStaffIds: unoccupiedStaffIds(this.world),
      nowMs: this.lastTime,
      hoveredEntity: this.hoveredEntity,
      highlightedStaffIds: this.highlightedStaffIds,
    };
  },
  setupEventHandlers() {
    let isDragging = false,
      dragStartX = 0,
      dragStartY = 0;
    this.canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (isDragging) {
        this.camera.x += e.clientX - dragStartX;
        this.camera.y += e.clientY - dragStartY;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
      }
      this.handleMouseMove(e);
    });
    this.canvas.addEventListener('mouseup', () => {
      isDragging = false;
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredEntity = null;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY > 0 ? 0.9 : 1.1;
      this.camera.zoom = Math.max(0.5, Math.min(2.0, this.camera.zoom * d));
    });
    document.getElementById('sandboxBtn').addEventListener('click', () => this.enterSandboxMode());
    document.getElementById('liveBtn').addEventListener('click', () => this.exitSandboxMode());
    this.installDelegatedHandlers();
  },

  /**
   * Every click in the page goes through one listener here.
   *
   * The panels are rebuilt with innerHTML, which destroys their children, so a
   * listener attached to a generated button would be silently dropped on the
   * next rebuild. This also replaces the inline onclick attributes, which only
   * worked because this object happened to be global.
   */
  installDelegatedHandlers() {
    const staffId = (el) => Number(el.dataset.staffId);
    const equipmentId = (el) => Number(el.dataset.equipmentId);

    installActions(document, {
      'reset-camera': () => this.resetCamera(),
      'toggle-panel': (el) => this.togglePanel(el),
      'open-buy-modal': () => this.openBuyModal(),
      'close-modals': () => this.closeAllModals(),
      'save-session': (el) => this.saveSessionToServer(el),
      'show-session': (el) => this.showSessionDetails(el.dataset.sessionId),
      'open-task-modal': (el) => this.openTaskModal(staffId(el)),
      'toggle-shift': (el) => this.toggleShift(staffId(el)),
      'toggle-sick': (el) => this.setStaffStatus(staffId(el), 'sick'),
      'open-emergency': (el) => this.openEmergencyModalById(el.dataset.emergencyId),
      'assign-task': (el) => this.assignTask(el.dataset.taskId),
      'assign-emergency': (el) => this.assignEmergencyTask(staffId(el)),
      'start-training': (el) => this.assignTraining(el.dataset.skill, equipmentId(el)),
      repair: (el) => this.repairEquipment(equipmentId(el)),
      calibrate: (el) => this.calibrateEquipment(equipmentId(el)),
      'buy-equipment': (el) => this.buyEquipment(el.dataset.catalogId),
      logout: () => Auth.logout(),
    });

    installHover(
      document,
      '[data-hover-task]',
      (el) => this.highlightQualifiedStaff(el.dataset.hoverTask),
      () => this.clearStaffHighlights(),
    );

    installEscape(() => this.closeAllModals());
  },
  handleMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    let foundEntity = null;
    const allEntities = [...this.staff, ...this.equipment];
    for (const entity of allEntities) {
      const iso = this.renderer.getScreenCoords(entity.x, entity.y);
      const dist = Math.sqrt(Math.pow(mouseX - iso.x, 2) + Math.pow(mouseY - iso.y, 2));
      if (dist < 20 * this.camera.zoom) {
        foundEntity = entity;
        break;
      }
    }
    this.hoveredEntity = foundEntity;
  },
  highlightQualifiedStaff(taskId) {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    this.highlightedStaffIds = this.staff.filter((p) => isQualified(p, task)).map((p) => p.id);
    this.updateStaffPanel();
  },
  clearStaffHighlights() {
    this.highlightedStaffIds = [];
    this.updateStaffPanel();
  },

  enterSandboxMode() {
    if (this.isSandboxMode) return;
    this.isSandboxMode = true;
    // One snapshot of the whole world rather than four hand-picked slices, so
    // nothing done in the sandbox can leak back into the live run.
    this.liveWorldBackup = cloneWorld(this.world);

    const newSession = { id: 'SBX' + Date.now(), startTime: new Date(), actions: [] };
    this.sandboxSessionHistory.unshift(newSession);
    this.currentSandboxSession = newSession;
    this.logSandboxAction('Entered Sandbox Mode.');

    document.body.classList.add('sandbox-mode');
    document.getElementById('sandboxBtn').classList.add('active');
    document.getElementById('liveBtn').classList.remove('active');
    document.getElementById('sandboxLogPanel').style.display = 'block';
    this.updateSandboxLogPanel();
    this.showNotification(
      'Entered Sandbox Mode. Changes will not affect the live simulation.',
      'info',
    );
  },

  exitSandboxMode() {
    if (!this.isSandboxMode) return;
    this.isSandboxMode = false;
    this.world = this.liveWorldBackup;
    this.liveWorldBackup = null;
    this.currentSandboxSession = null;

    document.body.classList.remove('sandbox-mode');
    document.getElementById('liveBtn').classList.add('active');
    document.getElementById('sandboxBtn').classList.remove('active');
    document.getElementById('sandboxLogPanel').style.display = 'none';

    this.updateAllPanels();
    this.updateSessionHistoryPanel();
    this.showNotification('Returned to Live Mode. All changes reverted.', 'info');
  },

  logSandboxAction(actionText) {
    if (!this.isSandboxMode || !this.currentSandboxSession) return;
    const time = new Date();
    const timestamp = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}:${time.getSeconds().toString().padStart(2, '0')}`;
    this.currentSandboxSession.actions.unshift(`[${timestamp}] ${actionText}`);
    this.updateSandboxLogPanel();
  },

  updateSandboxLogPanel() {
    if (!this.isSandboxMode || !this.currentSandboxSession) return;
    const listEl = document.getElementById('sandboxLogList');
    if (!listEl) return;
    if (this.currentSandboxSession.actions.length === 0) {
      setHtml(
        listEl,
        html`<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">
          No actions logged yet.
        </div>`,
      );
      return;
    }
    setHtml(
      listEl,
      html`${this.currentSandboxSession.actions.map(
        (entry) =>
          html`<div
            style="font-size: 0.8rem; padding: 0.25rem 0; border-bottom: 1px solid #f1f5f9;"
          >
            ${entry}
          </div>`,
      )}`,
    );
  },

  updateSessionHistoryPanel() {
    const listEl = document.getElementById('sandboxHistoryList');
    if (!listEl) return;
    if (this.sandboxSessionHistory.length === 0) {
      setHtml(
        listEl,
        html`<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">
          No sandbox sessions recorded.
        </div>`,
      );
      return;
    }
    setHtml(
      listEl,
      html`${this.sandboxSessionHistory.map((session) => {
        const date = session.startTime.toLocaleDateString();
        const time = session.startTime.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        const savedBadge = session.savedToServer
          ? html`<span
              style="color:#10b981;font-size:0.75rem;margin-left:0.5rem;"
              title="Saved to server"
              >☁️ Saved</span
            >`
          : '';
        return html`<div
          class="session-history-item"
          data-action="show-session"
          data-session-id="${session.id}"
        >
          <strong>Session from ${date}</strong>${savedBadge}<br />
          <small>${time} — ${session.actions.length} actions recorded</small>
        </div>`;
      })}`,
    );
  },

  showSessionDetails(sessionId) {
    const session = this.sandboxSessionHistory.find((s) => s.id === sessionId);
    if (!session) return;

    const headerEl = document.getElementById('sessionDetailsHeader');
    const contentEl = document.getElementById('sessionDetailsContent');
    const time = session.startTime.toLocaleString();
    headerEl.textContent = `Log for Session: ${time}`;

    if (session.actions.length === 0) {
      contentEl.textContent = 'No actions were recorded in this session.';
    } else {
      setHtml(
        contentEl,
        html`${session.actions
          .slice()
          .reverse()
          .map((action) => html`<div>${action}</div>`)}`,
      );
    }

    document.getElementById('modalOverlay').className = 'modal-overlay active';
    document.getElementById('sessionDetailsModal').className = 'modal active';
  },

  async saveSessionToServer(btnEl) {
    if (!this.currentSandboxSession) {
      this.showNotification('No active sandbox session to save.', 'error');
      return;
    }
    if (!Auth.isLoggedIn()) {
      this.showNotification('Sign in to save your sessions.', 'info');
      window.location.href = 'login.html';
      return;
    }
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '⏳ Saving...';
    }
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + Auth.token,
        },
        body: JSON.stringify({
          sessionId: this.currentSandboxSession.id,
          startTime: this.currentSandboxSession.startTime,
          actions: this.currentSandboxSession.actions,
          finalState: {
            money: Math.round(this.world.money),
            materials: this.world.materials,
            samples: this.world.samples,
          },
        }),
      });
      if (response.status === 401) {
        Auth.logout();
        return;
      }
      if (!response.ok) throw new Error('Server error');
      this.currentSandboxSession.savedToServer = true;
      if (btnEl) {
        btnEl.textContent = '✅ Saved';
      }
      this.showNotification('Session saved to your account.', 'success');
      this.updateSessionHistoryPanel();
    } catch {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '💾 Save';
      }
      this.showNotification('Could not save — is the server running? (npm start)', 'error');
    }
  },

  updateTimeOfDayOverlay() {
    const hours = this.world.minutes / 60;
    let color = 'rgba(0,0,0,0)';
    if (hours < 6 || hours >= 21) {
      color = 'rgba(12, 28, 64, 0.4)';
    } else if (hours >= 6 && hours < 9) {
      color = 'rgba(255, 215, 135, 0.15)';
    } else if (hours >= 18 && hours < 21) {
      color = 'rgba(255, 140, 0, 0.25)';
    }
    this.timeOverlay.style.backgroundColor = color;
  },
  /**
   * Turns engine events into the things a person sees: a toast, a line in the
   * sandbox log, a modal closing. The engine reports facts; the wording lives
   * here, which is what lets the same simulation run with nothing attached.
   */
  handleEvents(events) {
    // Any event other than a refusal changed something a panel shows, so the
    // panels are rebuilt from the event stream rather than on every frame.
    if (events.some(isPanelAffecting)) this.updateAllPanels();
    for (const e of events) {
      switch (e.type) {
        case 'task-assigned':
          this.announce(`${e.staffName} assigned to "${e.taskName}"`, 'info');
          break;
        case 'task-completed':
          this.showNotification(
            `Task "${e.taskName}" completed by ${e.staffName}. +$${e.reward}`,
            'success',
          );
          break;
        case 'task-failed':
          this.announce(`Task "${e.taskName}" failed! Penalty: $${e.penalty}`, 'error');
          break;
        case 'training-started':
          this.announce(`${e.staffName} started training on ${e.skill}. (-$${e.cost})`, 'info');
          break;
        case 'training-completed':
          this.showNotification(`${e.staffName} is now certified for ${e.skill}!`, 'success');
          break;
        case 'emergency-raised':
          this.flashEmergencyPanel();
          this.openEmergencyModalById(e.emergencyId);
          break;
        case 'emergency-expired':
          this.showNotification(
            `Unassigned emergency task failed! Penalty: $${e.penalty}!`,
            'error',
          );
          if (this.activeEmergencyTask && this.activeEmergencyTask.id === e.emergencyId) {
            this.closeAllModals();
          }
          break;
        case 'equipment-serviced':
          this.announce(
            `${e.equipmentName} ${e.kind === 'repair' ? 'repaired' : 'calibrated'} for $${e.cost}.`,
            'info',
          );
          break;
        case 'equipment-purchased':
          this.announce(
            `${e.equipmentName} purchased for $${e.cost} and placed in the lab.`,
            'info',
          );
          break;
        case 'staff-status-changed':
          this.logSandboxAction(`${e.staffName}'s status changed to ${e.status}.`);
          break;
        case 'shift-toggled':
          this.announce(
            `${e.staffName} has ${e.onShift ? 'started' : 'ended'} their shift`,
            'info',
          );
          break;
        case 'rejected':
          this.showNotification(this.describeRejection(e), 'error');
          break;
      }
    }
  },

  /** A message that is both shown and recorded in the sandbox log. */
  announce(message, type) {
    this.showNotification(message, type);
    this.logSandboxAction(message);
  },

  describeRejection(e) {
    switch (e.reason) {
      case 'not-idle':
        return `Assignment failed: ${e.detail} is busy.`;
      case 'unqualified':
        return `Assignment failed: ${e.detail} is not qualified for this task.`;
      case 'equipment-in-use': {
        const [name, user] = (e.detail || '').split('|');
        return `${name} is currently in use${user ? ` by ${user}` : ''}.`;
      }
      case 'no-funds':
        return `Insufficient funds (cost: $${e.detail}, budget: $${this.world.money.toFixed(0)}).`;
      case 'already-known':
        return `Already certified for ${e.detail}.`;
      case 'off-shift':
        return `${e.detail} is off shift — start their shift first.`;
      case 'no-space':
        return 'No free space in the lab for new equipment.';
      default:
        return 'That is not possible right now.';
    }
  },

  /** One way in: a click becomes a command, never a direct change to the world. */
  dispatch(command) {
    this.handleEvents(applyCommand(this.world, command));
  },

  assignTask(taskId) {
    if (!this.selectedStaff) return;
    this.dispatch({ type: 'ASSIGN_TASK', staffId: this.selectedStaff.id, taskId });
    this.closeAllModals();
  },

  assignTraining(skillToLearn, equipmentId) {
    if (!this.selectedStaff) return;
    this.dispatch({
      type: 'START_TRAINING',
      staffId: this.selectedStaff.id,
      equipmentId,
      skill: skillToLearn,
    });
    this.closeAllModals();
  },

  assignEmergencyTask(staffId) {
    const person = this.staff.find((p) => p.id === staffId);
    if (!person || !this.activeEmergencyTask) return;
    this.selectedStaff = person;
    this.dispatch({
      type: 'ASSIGN_EMERGENCY',
      staffId,
      emergencyId: this.activeEmergencyTask.id,
    });
    this.closeAllModals();
  },

  setStaffStatus(staffId, newStatus) {
    const person = this.staff.find((p) => p.id === staffId);
    if (!person) return;
    this.dispatch({
      type: 'SET_STATUS',
      staffId,
      sick: person.state !== 'sick' && newStatus === 'sick',
    });
  },

  toggleShift(staffId) {
    this.dispatch({ type: 'TOGGLE_SHIFT', staffId });
  },

  repairEquipment(equipmentId) {
    this.dispatch({ type: 'SERVICE_EQUIPMENT', equipmentId, kind: 'repair' });
  },

  calibrateEquipment(equipmentId) {
    this.dispatch({ type: 'SERVICE_EQUIPMENT', equipmentId, kind: 'calibrate' });
  },

  buyEquipment(catalogId) {
    this.dispatch({ type: 'BUY_EQUIPMENT', catalogId });
    this.closeAllModals();
  },

  gameLoop() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.handleEvents(
      tick(this.world, dt, {
        freezeClock: this.isSandboxMode,
        movementMultiplier: this.isSandboxMode ? 5 : 1,
      }),
    );
    // Previously these four ran on every frame, rebuilding each panel's whole
    // subtree with innerHTML about 240 times a second between them, and
    // throwing away scroll position and hover state each time. Panels that
    // react to a change are driven by the event stream instead; this interval
    // only covers the things that tick down on their own.
    if (now - this.lastPanelTick >= PANEL_INTERVAL_MS) {
      this.lastPanelTick = now;
      this.updateTimeOfDayOverlay();
      this.updateUI();
      this.updateStatusCounts();
      this.updateEmergencyListPanel();
      this.updateOngoingTasksPanel();
      this.updateEmergencyModalDeadline();
    }

    this.renderer.render(this.buildRenderView());
    requestAnimationFrame(() => this.gameLoop());
  },
  /**
   * Keeps the open emergency modal's countdown moving. This used to live
   * inside the emergency update loop, which now runs in the engine and cannot
   * touch the DOM, so it moved here with the rest of the view work.
   */
  updateEmergencyModalDeadline() {
    if (!this.activeEmergencyTask) return;
    const live = this.emergencyQueue.find((t) => t.id === this.activeEmergencyTask.id);
    if (!live) return;
    setHtmlById(
      'emergencyTaskDeadline',
      html`<strong>Deadline:</strong> ${formatDuration(live.timeLimit, true)}`,
    );
  },
  updateUI() {
    document.getElementById('money').textContent = this.world.money.toFixed(0);
    document.getElementById('materials').textContent = this.world.materials;
    document.getElementById('samples').textContent = this.world.samples;
  },
  updateStatusCounts() {
    const c = { working: 0, break: 0, off: 0, sick: 0, vacation: 0, training: 0 };
    this.staff.forEach((p) => {
      if (p.state === 'working' || p.state === 'idle') {
        c.working++;
      } else if (p.state === 'break') {
        c.break++;
      } else if (p.state === 'off') {
        c.off++;
      } else if (p.state === 'sick') {
        c.sick++;
      } else if (p.state === 'vacation') {
        c.vacation++;
      }
    });
    c.training = countTraining(this.world);
    document.getElementById('workingCount').textContent = c.working;
    document.getElementById('breakCount').textContent = c.break;
    document.getElementById('offCount').textContent = c.off;
    document.getElementById('sickCount').textContent = c.sick;
    document.getElementById('vacationCount').textContent = c.vacation;
    document.getElementById('trainingCount').textContent = c.training;
  },
  updateStaffPanel() {
    const listEl = document.getElementById('staffList');
    setHtml(
      listEl,
      html`${this.staff.map((p) => {
        const energy = Math.floor(p.energy);
        const energyColor = energy > 60 ? '#10b981' : energy > 30 ? '#f59e0b' : '#ef4444';
        // An array of fragments rather than a joined string: html`` flattens
        // arrays and leaves nested results unescaped, whereas a pre-joined
        // string of markup would be escaped and shown as literal tags.
        const skillTags = p.skills.map((skill) => html`<span class="skill-tag">${skill}</span>`);
        const isHighlighted = this.highlightedStaffIds.includes(p.id);
        return html` <div class="staff-card ${isHighlighted ? 'qualified-highlight' : ''}">
          <div class="staff-header">
            <span class="staff-name">${p.name}</span>
            <span class="staff-badge badge-${p.state}">${p.state}</span>
          </div>
          <div class="energy-bar-container">
            <div class="energy-bar-label"><span>Energy</span><span>${energy}%</span></div>
            <div class="energy-bar">
              <div class="energy-fill" style="width: ${energy}%; background: ${energyColor};"></div>
            </div>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-light); margin-bottom: 0.25rem;">
            Task: ${describeAssignment(this.world, p)?.label ?? 'None'}
          </div>
          <div class="skills-container">
            ${skillTags.length ? skillTags : html`<span style="font-size: 0.75rem; color: var(--text-light);">No special skills.</span>`}
          </div>
          <div class="staff-actions">
            <button
              class="btn btn-primary btn-full"
              data-action="open-task-modal"
              data-staff-id="${p.id}"
              ${p.state !== 'idle' ? 'disabled' : ''}
            >
              Assign Task
            </button>
            <button class="btn btn-secondary" data-action="toggle-shift" data-staff-id="${p.id}">
              ${p.state === 'off' ? 'Start Shift' : 'End Shift'}
            </button>
            <button class="btn btn-secondary" data-action="toggle-sick" data-staff-id="${p.id}">
              ${p.state === 'sick' ? 'Clear Sick' : 'Set Sick'}
            </button>
          </div>
        </div>`;
      })}`,
    );
  },
  updateEquipmentPanel() {
    setHtml(
      document.getElementById('equipmentList'),
      html`${this.equipment.map(
        (eq) =>
          html`<div class="equipment-card">
            <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem;">
              <span style="font-size: 24px;">${eq.icon}</span>
              <div style="flex: 1;">
                <strong>${eq.name}</strong>
                <div class="equipment-info">
                  ${eq.inUse ? '🔴 In Use' : '🟢 Available'} | Use:
                  ${formatDuration(eq.totalWorkTime)}
                </div>
              </div>
            </div>
            <div class="condition-bar">
              <div
                class="condition-fill"
                style="width: ${eq.condition}%; background: ${eq.condition > 70 ? '#10b981' : eq.condition > 40 ? '#f59e0b' : '#ef4444'};"
              ></div>
            </div>
            <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
              <button class="btn" data-action="repair" data-equipment-id="${eq.id}">
                Repair ($${this.world.tuning.repairCost})</button
              ><button class="btn" data-action="calibrate" data-equipment-id="${eq.id}">
                Calibrate ($${this.world.tuning.calibrateCost})
              </button>
            </div>
          </div>`,
      )}`,
    );
  },
  updateEmergencyListPanel() {
    const p = document.getElementById('emergencyListPanel');
    if (!p) return;
    p.replaceChildren();
    const a = this.emergencyQueue.filter(
      (t) => t.status === 'pending' || t.status === 'in-progress',
    );
    if (a.length === 0) {
      setHtml(
        p,
        html`<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">
          No active emergencies.
        </div>`,
      );
      return;
    }
    a.forEach((t) => {
      const s = t.status === 'pending' ? 'Waiting' : 'In Progress';
      appendHtml(
        p,
        html`<div class="emergency-card" data-action="open-emergency" data-emergency-id="${t.id}">
          <strong>${t.name}</strong>
          <div><span>${s}</span><span>Time Left: ${formatDuration(t.timeLimit, true)}</span></div>
        </div>`,
      );
    });
  },
  updateTaskListPanel() {
    const panel = document.getElementById('taskListPanel');
    if (!panel) return;
    setHtml(
      panel,
      html`${this.tasks.map((task) => {
        const totalTime = task.equipmentSequence.reduce((acc, step) => acc + step.duration, 0);
        const skills = task.equipmentSequence.map((s) => s.skillRequired).join(', ');
        const qualifiedStaff =
          this.staff
            .filter((p) => p.state === 'idle' && isQualified(p, task))
            .map((p) => p.name)
            .join(', ') || 'None available';
        return html` <div class="task-def-card" data-hover-task="${task.id}">
          <strong>${task.name}</strong>
          <div class="details">
            <span>Time: ${formatDuration(totalTime)} | Reward: $${task.reward}</span><br />
            <strong>Required Skills:</strong> ${skills}<br /><strong>Qualified Staff:</strong>
            ${qualifiedStaff}
          </div>
        </div>`;
      })}`,
    );
  },
  updateOngoingTasksPanel() {
    const panel = document.getElementById('ongoingTasksPanel');
    if (!panel) return;
    const active = listActiveWork(this.world);
    if (active.length === 0) {
      setHtml(
        panel,
        html`<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">
          No tasks in progress.
        </div>`,
      );
      return;
    }
    setHtml(
      panel,
      html`${active.map(
        (item) =>
          html`<div class="ongoing-task-card">
            <strong>${item.name}</strong>
            <div class="info">Assigned to: ${item.assignee} (${item.statusText})</div>
            <div class="progress-bar">
              <div
                class="progress-fill"
                style="width: ${item.progress * 100}%; background: #a78bfa;"
              ></div>
            </div>
          </div>`,
      )}`,
    );
  },
  openTaskModal(staffId) {
    this.selectedStaff = this.staff.find((p) => p.id === staffId);
    if (!this.selectedStaff) return;
    // Someone who has just been given a task is still 'idle' until they reach
    // the machine, so reporting their state would say "is currently idle".
    // Describe the task when there is one.
    const current = describeAssignment(this.world, this.selectedStaff);
    if (current) {
      this.showNotification(
        `Cannot assign task: ${this.selectedStaff.name} is already on "${current.label}".`,
        'error',
      );
      return;
    }
    if (this.selectedStaff.state !== 'idle') {
      this.showNotification(
        `Cannot assign task: ${this.selectedStaff.name} is currently ${this.selectedStaff.state}.`,
        'error',
      );
      return;
    }
    document.getElementById('selectedStaffName').textContent = this.selectedStaff.name;
    document.getElementById('modalOverlay').className = 'modal-overlay active';
    document.getElementById('taskModal').className = 'modal active';
    const o = document.getElementById('taskOptions');
    const options = [];
    this.tasks.forEach((t, i) => {
      const q = isQualified(this.selectedStaff, t);
      options.push(
        html`<div
          class="task-option"
          ${!q ? 'disabled' : ''}
          ${q ? html`data-action="assign-task" data-task-id="${t.id}"` : ''}
        >
          <strong>${t.name}</strong>
          <div style="font-size:0.875rem;color:#64748b;">
            Reward: $${t.reward} | Time: ${formatDuration(t.timeLimit, true)} |
            ${q ? '✅ Qualified' : '❌ Not Qualified'}
          </div>
        </div>`,
      );
    });
    this.equipment.forEach((eq) => {
      if (!this.selectedStaff.skills.includes(eq.skill)) {
        options.push(
          html`<div
            class="task-option"
            data-action="start-training"
            data-skill="${eq.skill}"
            data-equipment-id="${eq.id}"
          >
            <strong>🎓 Train: ${eq.name}</strong>
            <div style="font-size:0.875rem;color:#64748b;">
              Cost: $${this.scenario.tuning.trainingCost} | Duration:
              ${this.scenario.tuning.trainingDuration} min
            </div>
          </div>`,
        );
      }
    });
    setHtml(o, html`${options}`);
  },
  closeAllModals() {
    document
      .querySelectorAll('.modal.active, .modal-overlay.active')
      .forEach((el) => el.classList.remove('active'));
    this.selectedStaff = null;
    this.activeEmergencyTask = null;
  },
  openEmergencyModalById(id) {
    const task = this.emergencyQueue.find((t) => t.id === id);
    if (task) this.openEmergencyModal(task);
  },
  openEmergencyModal(task) {
    this.activeEmergencyTask = task;
    setHtml(
      document.getElementById('emergencyTaskName'),
      html`<strong>Task:</strong> ${task.name}`,
    );
    setHtmlById('emergencyTaskReward', html`<strong>Reward:</strong> $${task.reward}`);
    setHtmlById('emergencyTaskPenalty', html`<strong>Penalty:</strong> $${task.penalty}`);
    setHtmlById(
      'emergencyTaskDeadline',
      html`<strong>Deadline:</strong> ${formatDuration(task.timeLimit, true)}`,
    );
    const staffListEl = document.getElementById('emergencyStaffList');
    staffListEl.replaceChildren();
    const availableStaff = this.staff.filter(
      (p) => isUnoccupied(this.world, p) && isQualified(p, task),
    );
    if (availableStaff.length > 0) {
      availableStaff.forEach((p) => {
        appendHtml(
          staffListEl,
          html`<div
            class="staff-assign-option"
            data-action="assign-emergency"
            data-staff-id="${p.id}"
          >
            <span>${p.name}</span><small>Energy: ${Math.floor(p.energy)}%</small>
          </div>`,
        );
      });
    } else {
      setHtml(
        staffListEl,
        html`<div style="color: #b91c1c; text-align: center; font-weight: 600;">
          No qualified and available staff found!
        </div>`,
      );
    }
    document.getElementById('modalOverlay').className = 'modal-overlay active';
    document.getElementById('emergencyModal').className = 'modal active';
  },
  flashEmergencyPanel() {
    const header = document.getElementById('emergencyPanelHeader');
    if (!header) return;
    // Removing the class and reading offsetWidth forces a reflow, so the
    // animation restarts if a second emergency arrives while the first flash
    // is still playing. Without it the browser sees no change and does nothing.
    header.classList.remove('emergency-alert');
    void header.offsetWidth;
    header.classList.add('emergency-alert');
    header.addEventListener('animationend', () => header.classList.remove('emergency-alert'), {
      once: true,
    });
  },
  resetCamera() {
    // Previously duplicated the initial camera literals, so the two could
    // drift apart. Both now come from the scenario layout.
    Object.assign(this.camera, this.scenario.layout.initialCamera);
    this.showNotification('View reset', 'info');
  },
  togglePanel(headerEl) {
    const c = headerEl.nextElementSibling;
    const i = headerEl.querySelector('.panel-toggle-icon');
    c.classList.toggle('collapsed');
    if (c.classList.contains('collapsed')) {
      i.style.transform = 'rotate(-90deg)';
    } else {
      i.style.transform = 'rotate(0deg)';
    }
  },
  showNotification(message, type) {
    const n = document.createElement('div');
    n.className = 'notification';
    n.style.borderLeft = `4px solid ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'}`;
    setHtml(
      n,
      html`<div style="display:flex;align-items:center;gap:1rem;">
        <span style="font-size:20px;"
          >${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span
        ><span>${message}</span>
      </div>`,
    );
    document.body.appendChild(n);
    setTimeout(() => {
      n.style.opacity = '0';
      setTimeout(() => n.remove(), 300);
    }, 4000);
  },
  openBuyModal() {
    document.getElementById('modalOverlay').className = 'modal-overlay active';
    document.getElementById('buyEquipmentModal').className = 'modal active';
    const listEl = document.getElementById('equipmentCatalogList');
    setHtml(
      listEl,
      html`${this.equipmentCatalog.map(
        (item) => html`
          <div class="equipment-catalog-item">
            <span style="font-size: 24px;">${item.icon}</span>
            <div class="info">
              <strong>${item.name}</strong>
              <div style="font-size: 0.8rem; color: var(--text-light)">
                Requires Skill: ${item.skill}
              </div>
            </div>
            <div class="cost">$${item.cost}</div>
            <button
              class="btn btn-primary"
              data-action="buy-equipment"
              data-catalog-id="${item.id}"
              ${this.world.money < item.cost ? 'disabled' : ''}
            >
              Buy
            </button>
          </div>
        `,
      )}`,
    );
  },
};

// ── Auth state ───────────────────────────────────────────────────────────
const Auth = {
  token: localStorage.getItem('polaris_token') || null,
  user: JSON.parse(localStorage.getItem('polaris_user') || 'null'),

  isLoggedIn() {
    return !!this.token;
  },

  logout() {
    localStorage.removeItem('polaris_token');
    localStorage.removeItem('polaris_user');
    window.location.reload();
  },

  renderBar() {
    const bar = document.getElementById('authBar');
    if (!bar) return;
    if (this.isLoggedIn()) {
      setHtml(
        bar,
        html` <span
            style="font-size:0.8rem;color:#475569;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
            title="${this.user.email}"
            >👤 ${this.user.email}</span
          >
          <button
            data-action="logout"
            style="padding:0.35rem 0.75rem;border:1px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer;font-size:0.8rem;font-weight:600;color:#64748b;"
          >
            Log out
          </button>`,
      );
    } else {
      setHtml(
        bar,
        html` <span
            style="font-size:0.8rem;color:#64748b;background:#fef9c3;border:1px solid #fde047;padding:0.3rem 0.75rem;border-radius:20px;"
            >Demo Mode</span
          >
          <a
            href="login.html"
            style="padding:0.35rem 0.75rem;border:none;border-radius:8px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:white;text-decoration:none;font-size:0.8rem;font-weight:600;"
            >Sign In</a
          >`,
      );
    }
  },
};

window.addEventListener('DOMContentLoaded', async () => {
  Auth.renderBar();

  if (Auth.isLoggedIn()) {
    try {
      const res = await fetch('/api/business', {
        headers: { Authorization: 'Bearer ' + Auth.token },
      });
      if (res.status === 404) {
        window.location.href = 'onboarding.html';
        return;
      }
      if (res.ok) {
        Lab.businessProfile = await res.json();
        const title = Lab.businessProfile.name + ' — Simulation';
        document.title = title;
        document.getElementById('simTitle').textContent = title;
      }
    } catch {
      /* server not running — continue as demo */
    }
  }

  Lab.init();
});
