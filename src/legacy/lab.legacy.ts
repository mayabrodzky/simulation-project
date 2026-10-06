// @ts-nocheck
/**
 * The original inline <script> from lab-simulation.html, moved here verbatim.
 *
 * Nothing in this file has been changed yet. It is shrunk piece by piece over
 * Phase 1 as logic moves into src/engine, src/render, src/scenarios and src/ui,
 * and it is deleted entirely once nothing is left. @ts-nocheck suppresses type
 * checking until then; the rest of src/ is strict from the first line.
 */
import '../styles/base.css';
import '../styles/lab.css';
import { chemistryLab, scenarioFromBusinessProfile } from '../scenarios';
import { createRng } from '../engine/rng';
import { isQualified } from '../engine/rules';
import { createRenderer } from '../render/renderer';

const Lab = {
  scenario: chemistryLab,
  renderer: null,
  rng: createRng(1),
  seed: 1,
  canvas: null,
  ctx: null,
  width: 0,
  height: 0,
  timeOverlay: null,
  // Camera, starting economy and all geometry are filled from the scenario by
  // applyScenarioSettings() during init. Declared here only so the shape of the
  // object is still visible at a glance.
  camera: { x: 0, y: 0, zoom: 1 },
  state: { money: 0, materials: 0, samples: 0, time: 0, speed: 1 },
  isSandboxMode: false,
  liveStateBackup: null,
  gridWidth: 0,
  gridHeight: 0,
  labFloor: { x: 0, y: 0, w: 0, h: 0 },
  office1: { x: 0, y: 0, w: 0, h: 0 },
  office2: { x: 0, y: 0, w: 0, h: 0 },
  tileSize: 0,
  tileHeight: 0,
  staff: [],
  equipment: [],
  props: [],
  walls: [],
  staticPersonnel: [],
  tasks: [],
  activeTasks: [],
  emergencyQueue: [],
  equipmentCatalog: [],
  selectedStaff: null,
  activeEmergencyTask: null,
  hoveredEntity: null,
  highlightedStaffIds: [],
  sandboxSessionHistory: [],
  currentSandboxSession: null,

  init() {
    console.log('Initializing Upgraded Lab Simulation V14.8...');
    // Seeded so a run can be reproduced: ?seed=123 replays it exactly.
    // Without the parameter the seed is taken from the clock, which keeps
    // today's behaviour of a different lab on every load.
    const seedParam = new URLSearchParams(window.location.search).get('seed');
    this.seed = seedParam !== null && seedParam !== '' ? Number(seedParam) : Date.now();
    if (!Number.isFinite(this.seed)) this.seed = Date.now();
    this.rng = createRng(this.seed);
    console.log('Simulation seed:', this.seed);
    this.scenario = this.businessProfile
      ? scenarioFromBusinessProfile(this.businessProfile)
      : chemistryLab;
    this.applyScenarioSettings();
    const now = new Date();
    this.state.time = now.getHours() * 60 + now.getMinutes();
    this.canvas = document.getElementById('gameCanvas');
    this.timeOverlay = document.getElementById('timeOverlay');
    this.renderer = createRenderer(this.canvas);
    this.renderer.resize();
    window.addEventListener('resize', () => this.renderer.resize());
    this.createStaff();
    this.createEquipment();
    this.createEquipmentCatalog();
    this.createProps();
    this.createArchitecture();
    this.createBuildingOccupants();
    this.defineTasks();
    this.setupEventHandlers();
    this.lastTime = performance.now();
    this.gameLoop();
    this.updateAllPanels();
    this.updateSessionHistoryPanel();
  },
  /**
   * Copies the scenario's layout and starting values onto the fields the rest
   * of this file already reads, so every existing `this.labFloor` reference
   * keeps working while the literals themselves live in one place.
   */
  applyScenarioSettings() {
    const { layout, tuning } = this.scenario;
    this.gridWidth = layout.gridWidth;
    this.gridHeight = layout.gridHeight;
    this.tileSize = layout.tileSize;
    this.tileHeight = layout.tileHeight;
    this.labFloor = layout.labFloor;
    this.office1 = layout.office1;
    this.office2 = layout.office2;
    this.camera = { ...layout.initialCamera };
    this.state.money = tuning.startingMoney;
    this.state.materials = tuning.startingMaterials;
    this.state.samples = tuning.startingSamples;
    this.state.time = tuning.startMinutes;
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
      layout: this.scenario.layout,
      staff: this.staff,
      equipment: this.equipment,
      props: this.props,
      walls: this.walls,
      staticPersonnel: this.staticPersonnel,
      state: this.state,
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
  createStaff() {
    const f = this.labFloor;
    const t = this.scenario.tuning;
    this.scenario.staff.forEach((data, i) => {
      this.staff.push({
        id: i,
        ...data,
        x: f.x + 2 + (i % 4) * 3,
        y: f.y + 2 + Math.floor(i / 4) * 2,
        targetX: null,
        targetY: null,
        state: i < t.staffOnShiftCount ? 'idle' : 'off',
        energy: t.initialEnergyMin + this.rng.next() * t.initialEnergyRange,
        speed: t.staffWalkSpeed,
        color: `hsl(${i * 45}, 70%, 50%)`,
        activeTask: null,
        taskStep: 0,
        taskTimer: 0,
      });
    });
  },
  createEquipment() {
    const t = this.scenario.tuning;
    this.scenario.equipment.forEach((data) => {
      this.equipment.push({
        id: this.equipment.length,
        ...data,
        condition: t.initialConditionMin + this.rng.next() * t.initialConditionRange,
        inUse: false,
        assignedTo: null,
        totalWorkTime: 0,
      });
    });
  },
  createProps() {
    // Props and walls are scenario geometry; the door used to be appended here
    // by createArchitecture and is now declared with the other props.
    this.props = this.scenario.props.map((prop) => ({ ...prop }));
  },
  createBuildingOccupants() {
    this.staticPersonnel = [];
  },
  createArchitecture() {
    this.walls = this.scenario.walls.map((wall) => ({ ...wall }));
  },
  defineTasks() {
    this.scenario.tasks.forEach((task) => {
      this.tasks.push({
        ...task,
        equipmentSequence: task.equipmentSequence.map((step) => ({ ...step })),
      });
    });
  },
  createEquipmentCatalog() {
    this.equipmentCatalog = this.scenario.catalog.map((item) => ({ ...item }));
  },

  enterSandboxMode() {
    if (this.isSandboxMode) return;
    this.isSandboxMode = true;
    this.liveStateBackup = JSON.parse(
      JSON.stringify({
        state: this.state,
        staff: this.staff,
        equipment: this.equipment,
        emergencyQueue: this.emergencyQueue,
      }),
    );

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
    this.state = this.liveStateBackup.state;
    this.staff = this.liveStateBackup.staff;
    this.equipment = this.liveStateBackup.equipment;
    this.emergencyQueue = this.liveStateBackup.emergencyQueue;
    this.liveStateBackup = null;
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
      listEl.innerHTML = `<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">No actions logged yet.</div>`;
      return;
    }
    listEl.innerHTML = this.currentSandboxSession.actions
      .map(
        (entry) =>
          `<div style="font-size: 0.8rem; padding: 0.25rem 0; border-bottom: 1px solid #f1f5f9;">${entry}</div>`,
      )
      .join('');
  },

  updateSessionHistoryPanel() {
    const listEl = document.getElementById('sandboxHistoryList');
    if (!listEl) return;
    if (this.sandboxSessionHistory.length === 0) {
      listEl.innerHTML = `<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">No sandbox sessions recorded.</div>`;
      return;
    }
    listEl.innerHTML = this.sandboxSessionHistory
      .map((session) => {
        const date = session.startTime.toLocaleDateString();
        const time = session.startTime.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        const savedBadge = session.savedToServer
          ? `<span style="color:#10b981;font-size:0.75rem;margin-left:0.5rem;" title="Saved to server">☁️ Saved</span>`
          : '';
        return `<div class="session-history-item" onclick="Lab.showSessionDetails('${session.id}')">
                <strong>Session from ${date}</strong>${savedBadge}<br>
                <small>${time} — ${session.actions.length} actions recorded</small>
            </div>`;
      })
      .join('');
  },

  showSessionDetails(sessionId) {
    const session = this.sandboxSessionHistory.find((s) => s.id === sessionId);
    if (!session) return;

    const headerEl = document.getElementById('sessionDetailsHeader');
    const contentEl = document.getElementById('sessionDetailsContent');
    const time = session.startTime.toLocaleString();
    headerEl.textContent = `Log for Session: ${time}`;

    if (session.actions.length === 0) {
      contentEl.innerHTML = 'No actions were recorded in this session.';
    } else {
      contentEl.innerHTML = session.actions
        .slice()
        .reverse()
        .map((action) => `<div>${action}</div>`)
        .join('');
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
            money: Math.round(this.state.money),
            materials: this.state.materials,
            samples: this.state.samples,
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

  update(dt) {
    const gameDt = dt * this.state.speed;

    if (!this.isSandboxMode) {
      this.state.time += gameDt * this.scenario.tuning.minutesPerSecond;
      if (this.state.time >= 1440) this.state.time -= 1440;

      // A rate per simulated second, not a probability per frame. gameDt
      // already carries the speed multiplier.
      if (this.rng.chance(this.scenario.tuning.emergencyRatePerSecond, gameDt)) {
        if (this.emergencyQueue.filter((t) => t.status === 'pending').length === 0) {
          this.triggerEmergency();
        }
      }
      this.updateEmergencies(gameDt);
    }

    this.updateTimeOfDayOverlay();

    this.staff.forEach((person) => {
      if (person.state === 'off' || person.state === 'sick' || person.state === 'vacation') return;
      const tune = this.scenario.tuning;
      if (person.state === 'working') person.energy -= gameDt * tune.energyDrainPerSecond;
      if (person.state === 'break') person.energy += gameDt * tune.energyRecoverPerSecond;
      if (person.energy < tune.energyBreakThreshold && person.state !== 'break')
        person.state = 'break';
      if (person.energy > tune.energyRecoveredThreshold && person.state === 'break')
        person.state = 'idle';

      if (person.activeTask) {
        const task = person.activeTask;
        if (task.timeLimit !== undefined) {
          task.timeLimit -= gameDt;
          if (task.timeLimit <= 0) {
            this.failTask(person, task);
            return;
          }
        }
        if (task.type === 'training') {
          const equipment = this.equipment.find((eq) => eq.id === task.equipmentId);
          if (
            equipment &&
            Math.round(person.x) === equipment.x &&
            Math.round(person.y) === equipment.y
          ) {
            if (person.state !== 'working') {
              if (!equipment.inUse) {
                person.state = 'working';
                equipment.inUse = true;
                equipment.assignedTo = person.id;
                this.updateAllPanels();
              } else {
                person.state = 'idle';
              }
            }
            if (person.state === 'working') {
              person.taskTimer -= gameDt;
              if (person.taskTimer <= 0) {
                if (!person.skills.includes(task.skillToLearn))
                  person.skills.push(task.skillToLearn);
                this.showNotification(
                  `${person.name} is now certified for ${task.skillToLearn}!`,
                  'success',
                );
                if (equipment) {
                  equipment.inUse = false;
                  equipment.assignedTo = null;
                }
                person.activeTask = null;
                person.state = 'idle';
                this.updateAllPanels();
              }
            }
          }
        } else {
          const currentStep = task.equipmentSequence[person.taskStep];
          if (!currentStep) {
            person.activeTask = null;
            return;
          }
          const equipment = this.equipment.find((e) => e.name === currentStep.name);
          if (person.state === 'working') {
            person.taskTimer -= gameDt;
            if (person.taskTimer <= 0) {
              if (equipment) {
                equipment.inUse = false;
                equipment.assignedTo = null;
              }
              person.taskStep++;
              if (person.taskStep >= task.equipmentSequence.length) {
                this.state.money += task.reward;
                this.showNotification(
                  `Task "${task.name}" completed by ${person.name}. +$${task.reward}`,
                  'success',
                );
                if (task.isEmergency) {
                  const emergency = this.emergencyQueue.find((e) => e.id === task.id);
                  if (emergency) emergency.status = 'completed';
                }
                person.activeTask = null;
                person.taskStep = 0;
                person.state = 'idle';
              } else {
                const nextStep = task.equipmentSequence[person.taskStep];
                const nextEquipment = this.equipment.find((e) => e.name === nextStep.name);
                if (nextEquipment) {
                  person.targetX = nextEquipment.x;
                  person.targetY = nextEquipment.y;
                }
                person.state = 'idle';
              }
              this.updateAllPanels();
            }
          } else if (!equipment) {
            person.targetX = null;
            person.targetY = null;
            person.state = 'working';
            person.taskTimer = currentStep.duration;
            this.updateAllPanels();
          } else if (
            equipment &&
            Math.round(person.x) === equipment.x &&
            Math.round(person.y) === equipment.y
          ) {
            if (!equipment.inUse) {
              person.targetX = null;
              person.targetY = null;
              person.state = 'working';
              person.taskTimer = currentStep.duration;
              equipment.inUse = true;
              equipment.assignedTo = person.id;
              this.updateAllPanels();
            } else {
              person.state = 'idle';
            }
          }
        }
      }
      if (person.targetX !== null && person.targetY !== null) {
        const dx = person.targetX - person.x;
        const dy = person.targetY - person.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 0.1) {
          const moveSpeed = this.isSandboxMode ? person.speed * 5 : person.speed;
          person.x += (dx / dist) * moveSpeed * gameDt * 60;
          person.y += (dy / dist) * moveSpeed * gameDt * 60;
        } else {
          person.x = person.targetX;
          person.y = person.targetY;
        }
      } else if (
        person.state === 'idle' &&
        !person.activeTask &&
        this.rng.chance(this.scenario.tuning.wanderRatePerSecond, gameDt)
      ) {
        const f = this.labFloor;
        person.targetX = f.x + 1 + this.rng.next() * (f.w - 2);
        person.targetY = f.y + 1 + this.rng.next() * (f.h - 2);
      }
      const f = this.labFloor;
      person.x = Math.max(f.x + 0.5, Math.min(f.x + f.w - 0.5, person.x));
      person.y = Math.max(f.y + 0.5, Math.min(f.y + f.h - 0.5, person.y));
    });
    this.equipment.forEach((eq) => {
      if (eq.inUse) {
        eq.condition -= gameDt * this.scenario.tuning.conditionWearPerSecond;
        eq.totalWorkTime += gameDt;
      }
    });
    this.updateUI();
    this.updateStatusCounts();
    this.updateEmergencyListPanel();
    this.updateOngoingTasksPanel();
  },

  updateTimeOfDayOverlay() {
    const hours = this.state.time / 60;
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
  failTask(person, task) {
    this.state.money -= task.penalty;
    const failMessage = `Task "${task.name}" failed! Penalty: $${task.penalty}`;
    this.showNotification(failMessage, 'error');
    this.logSandboxAction(failMessage);
    const currentStep = task.equipmentSequence[person.taskStep];
    if (currentStep) {
      const equipment = this.equipment.find((e) => e.name === currentStep.name);
      if (equipment && equipment.assignedTo === person.id) {
        equipment.inUse = false;
        equipment.assignedTo = null;
        this.updateEquipmentPanel();
      }
    }
    if (task.isEmergency) {
      const emergency = this.emergencyQueue.find((e) => e.id === task.id);
      if (emergency) emergency.status = 'failed';
    }
    person.activeTask = null;
    person.taskStep = 0;
    person.state = 'idle';
    this.updateAllPanels();
  },
  gameLoop() {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.update(dt);
    this.renderer.render(this.buildRenderView());
    requestAnimationFrame(() => this.gameLoop());
  },
  updateUI() {
    document.getElementById('money').textContent = this.state.money.toFixed(0);
    document.getElementById('materials').textContent = this.state.materials;
    document.getElementById('samples').textContent = this.state.samples;
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
      if (p.activeTask && p.activeTask.type === 'training') {
        c.training++;
      }
    });
    document.getElementById('workingCount').textContent = c.working;
    document.getElementById('breakCount').textContent = c.break;
    document.getElementById('offCount').textContent = c.off;
    document.getElementById('sickCount').textContent = c.sick;
    document.getElementById('vacationCount').textContent = c.vacation;
    document.getElementById('trainingCount').textContent = c.training;
  },
  updateStaffPanel() {
    const listEl = document.getElementById('staffList');
    listEl.innerHTML = this.staff
      .map((p) => {
        const energy = Math.floor(p.energy);
        const energyColor = energy > 60 ? '#10b981' : energy > 30 ? '#f59e0b' : '#ef4444';
        const skillsHTML = p.skills
          .map((skill) => `<span class="skill-tag">${skill}</span>`)
          .join('');
        const isHighlighted = this.highlightedStaffIds.includes(p.id);
        return ` <div class="staff-card ${isHighlighted ? 'qualified-highlight' : ''}"> <div class="staff-header"> <span class="staff-name">${p.name}</span> <span class="staff-badge badge-${p.state}">${p.state}</span> </div> <div class="energy-bar-container"> <div class="energy-bar-label"><span>Energy</span><span>${energy}%</span></div> <div class="energy-bar"><div class="energy-fill" style="width: ${energy}%; background: ${energyColor};"></div></div> </div> <div style="font-size: 0.75rem; color: var(--text-light); margin-bottom: 0.25rem;">Task: ${p.activeTask ? p.activeTask.name : 'None'}</div> <div class="skills-container">${skillsHTML || '<span style="font-size: 0.75rem; color: var(--text-light);">No special skills.</span>'}</div> <div class="staff-actions"> <button class="btn btn-primary btn-full" onclick="Lab.openTaskModal(${p.id})" ${p.state !== 'idle' ? 'disabled' : ''}>Assign Task</button> <button class="btn btn-secondary" onclick="Lab.toggleShift(${p.id})">${p.state === 'off' ? 'Start Shift' : 'End Shift'}</button> <button class="btn btn-secondary" onclick="Lab.setStaffStatus(${p.id}, 'sick')">${p.state === 'sick' ? 'Clear Sick' : 'Set Sick'}</button> </div> </div>`;
      })
      .join('');
  },
  updateEquipmentPanel() {
    document.getElementById('equipmentList').innerHTML = this.equipment
      .map(
        (eq, i) =>
          `<div class="equipment-card"><div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.5rem;"><span style="font-size: 24px;">${eq.icon}</span><div style="flex: 1;"><strong>${eq.name}</strong><div class="equipment-info">${eq.inUse ? '🔴 In Use' : '🟢 Available'} | Use: ${this.formatTime(eq.totalWorkTime)}</div></div></div><div class="condition-bar"><div class="condition-fill" style="width: ${eq.condition}%; background: ${eq.condition > 70 ? '#10b981' : eq.condition > 40 ? '#f59e0b' : '#ef4444'};"></div></div><div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;"><button class="btn" onclick="Lab.repairEquipment(${i})">Repair ($200)</button><button class="btn" onclick="Lab.calibrateEquipment(${i})">Calibrate ($100)</button></div></div>`,
      )
      .join('');
  },
  updateEmergencyListPanel() {
    const p = document.getElementById('emergencyListPanel');
    if (!p) return;
    p.innerHTML = '';
    const a = this.emergencyQueue.filter(
      (t) => t.status === 'pending' || t.status === 'in-progress',
    );
    if (a.length === 0) {
      p.innerHTML = `<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">No active emergencies.</div>`;
      return;
    }
    a.forEach((t) => {
      const s = t.status === 'pending' ? 'Waiting' : 'In Progress';
      p.innerHTML += `<div class="emergency-card" onclick="Lab.openEmergencyModalById('${t.id}')"><strong>${t.name}</strong><div><span>${s}</span><span>Time Left: ${this.formatTime(t.timeLimit, true)}</span></div></div>`;
    });
  },
  updateTaskListPanel() {
    const panel = document.getElementById('taskListPanel');
    if (!panel) return;
    panel.innerHTML = this.tasks
      .map((task) => {
        const totalTime = task.equipmentSequence.reduce((acc, step) => acc + step.duration, 0);
        const skills = task.equipmentSequence.map((s) => s.skillRequired).join(', ');
        const qualifiedStaff =
          this.staff
            .filter((p) => p.state === 'idle' && isQualified(p, task))
            .map((p) => p.name)
            .join(', ') || 'None available';
        return ` <div class="task-def-card" onmouseenter="Lab.highlightQualifiedStaff('${task.id}')" onmouseleave="Lab.clearStaffHighlights()"> <strong>${task.name}</strong> <div class="details"> <span>Time: ${this.formatTime(totalTime)} | Reward: $${task.reward}</span><br> <strong>Required Skills:</strong> ${skills}<br><strong>Qualified Staff:</strong> ${qualifiedStaff}</div> </div>`;
      })
      .join('');
  },
  updateOngoingTasksPanel() {
    const panel = document.getElementById('ongoingTasksPanel');
    if (!panel) return;
    const activeStaff = this.staff.filter((p) => p.activeTask);
    if (activeStaff.length === 0) {
      panel.innerHTML = `<div style="font-size:0.875rem;color:#64748b;padding:1rem 0;">No tasks in progress.</div>`;
      return;
    }
    panel.innerHTML = activeStaff
      .map((p) => {
        const task = p.activeTask;
        let progress = 0;
        let statusText = 'Moving to equipment';
        if (p.state === 'working') {
          if (task.type === 'training') {
            statusText = 'Training in progress';
            progress = Math.max(0, 100 * (1 - p.taskTimer / task.duration));
          } else {
            statusText = 'Processing';
            const currentStep = task.equipmentSequence[p.taskStep];
            if (currentStep) {
              progress = Math.max(0, 100 * (1 - p.taskTimer / currentStep.duration));
            }
          }
        }
        return `<div class="ongoing-task-card"><strong>${task.name}</strong><div class="info">Assigned to: ${p.name} (${statusText})</div><div class="progress-bar"><div class="progress-fill" style="width: ${progress}%; background: #a78bfa;"></div></div></div>`;
      })
      .join('');
  },
  openTaskModal(staffId) {
    this.selectedStaff = this.staff[staffId];
    if (this.selectedStaff.state !== 'idle' || this.selectedStaff.activeTask) {
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
    let h = '';
    this.tasks.forEach((t, i) => {
      const q = isQualified(this.selectedStaff, t);
      h += `<div class="task-option" ${!q ? 'disabled' : ''} onclick="${q ? `Lab.assignNewTask(${i})` : ''}"><strong>${t.name}</strong><div style="font-size:0.875rem;color:#64748b;">Reward: $${t.reward} | Time: ${this.formatTime(t.timeLimit, true)} | ${q ? '✅ Qualified' : '❌ Not Qualified'}</div></div>`;
    });
    this.equipment.forEach((eq) => {
      if (!this.selectedStaff.skills.includes(eq.skill)) {
        h += `<div class="task-option" onclick="Lab.assignTraining('${eq.skill}', ${eq.id})"><strong>🎓 Train: ${eq.name}</strong><div style="font-size:0.875rem;color:#64748b;">Cost: $${this.scenario.tuning.trainingCost} | Duration: ${this.scenario.tuning.trainingDuration} min</div></div>`;
      }
    });
    o.innerHTML = h;
  },
  closeAllModals() {
    document
      .querySelectorAll('.modal.active, .modal-overlay.active')
      .forEach((el) => el.classList.remove('active'));
    this.selectedStaff = null;
    this.activeEmergencyTask = null;
  },
  assignNewTask(taskIndex, isEmergency = false, emergencyId = null) {
    if (!this.selectedStaff) return;
    let taskSource;
    if (isEmergency) {
      taskSource = this.emergencyQueue.find((t) => t.id === emergencyId);
    } else {
      taskSource = this.tasks[taskIndex];
    }
    if (!taskSource) return;
    if (this.selectedStaff.state !== 'idle' || this.selectedStaff.activeTask) {
      this.showNotification(
        `Assignment failed: ${this.selectedStaff.name} is currently ${this.selectedStaff.state}.`,
        'error',
      );
      return;
    }
    const qualified = isQualified(this.selectedStaff, taskSource);
    if (!qualified) {
      this.showNotification(
        `Assignment failed: ${this.selectedStaff.name} is not qualified for this task.`,
        'error',
      );
      return;
    }
    const firstStep = taskSource.equipmentSequence[0];
    const firstEquipment = this.equipment.find((e) => e.name === firstStep.name);
    if (firstEquipment && firstEquipment.inUse) {
      const user = this.staff.find((s) => s.id === firstEquipment.assignedTo);
      const userName = user ? `by ${user.name}` : '';
      this.showNotification(
        `Assignment failed: ${firstEquipment.name} is currently in use ${userName}.`,
        'error',
      );
      return;
    }
    const taskCopy = JSON.parse(JSON.stringify(taskSource));
    if (isEmergency) {
      taskCopy.isEmergency = true;
      taskSource.status = 'in-progress';
      taskSource.assignedTo = this.selectedStaff.id;
    }
    this.selectedStaff.activeTask = taskCopy;
    this.selectedStaff.taskStep = 0;
    if (firstEquipment) {
      this.selectedStaff.targetX = firstEquipment.x;
      this.selectedStaff.targetY = firstEquipment.y;
    }
    const actionMessage = `${this.selectedStaff.name} assigned to "${taskCopy.name}"`;
    this.showNotification(actionMessage, 'info');
    this.logSandboxAction(actionMessage);
    this.closeAllModals();
    this.updateAllPanels();
  },
  assignTraining(skillToLearn, equipmentId) {
    if (!this.selectedStaff) return;
    const cost = this.scenario.tuning.trainingCost;
    const trainingDuration = this.scenario.tuning.trainingDuration;
    const equipment = this.equipment.find((eq) => eq.id === equipmentId);
    if (this.state.money < cost) {
      this.showNotification(
        `Training failed: Insufficient funds (Cost: $${cost}, Budget: $${this.state.money.toFixed(0)}).`,
        'error',
      );
      return;
    }
    if (equipment.inUse) {
      const user = this.staff.find((s) => s.id === equipment.assignedTo);
      const userName = user ? `by ${user.name}` : '';
      this.showNotification(
        `Training failed: ${equipment.name} is unavailable for training, it's in use ${userName}.`,
        'error',
      );
      return;
    }
    this.state.money -= cost;
    this.selectedStaff.activeTask = {
      type: 'training',
      name: `Training on ${equipment.name}`,
      skillToLearn: skillToLearn,
      equipmentId: equipmentId,
      duration: trainingDuration,
    };
    this.selectedStaff.taskTimer = trainingDuration;
    this.selectedStaff.targetX = equipment.x;
    this.selectedStaff.targetY = equipment.y;
    const actionMessage = `${this.selectedStaff.name} started training on ${equipment.name}. (-$${cost})`;
    this.showNotification(actionMessage, 'info');
    this.logSandboxAction(actionMessage);
    this.closeAllModals();
    this.updateAllPanels();
  },
  openEmergencyModalById(id) {
    const task = this.emergencyQueue.find((t) => t.id === id);
    if (task) this.openEmergencyModal(task);
  },
  openEmergencyModal(task) {
    this.activeEmergencyTask = task;
    document.getElementById('emergencyTaskName').innerHTML = `<strong>Task:</strong> ${task.name}`;
    document.getElementById('emergencyTaskReward').innerHTML =
      `<strong>Reward:</strong> $${task.reward}`;
    document.getElementById('emergencyTaskPenalty').innerHTML =
      `<strong>Penalty:</strong> $${task.penalty}`;
    document.getElementById('emergencyTaskDeadline').innerHTML =
      `<strong>Deadline:</strong> ${this.formatTime(task.timeLimit, true)}`;
    const staffListEl = document.getElementById('emergencyStaffList');
    staffListEl.innerHTML = '';
    const availableStaff = this.staff.filter(
      (p) => p.state === 'idle' && !p.activeTask && isQualified(p, task),
    );
    if (availableStaff.length > 0) {
      availableStaff.forEach((p) => {
        staffListEl.innerHTML += `<div class="staff-assign-option" onclick="Lab.assignEmergencyTask(${p.id})"><span>${p.name}</span><small>Energy: ${Math.floor(p.energy)}%</small></div>`;
      });
    } else {
      staffListEl.innerHTML = `<div style="color: #b91c1c; text-align: center; font-weight: 600;">No qualified and available staff found!</div>`;
    }
    document.getElementById('modalOverlay').className = 'modal-overlay active';
    document.getElementById('emergencyModal').className = 'modal active';
  },
  assignEmergencyTask(staffId) {
    this.selectedStaff = this.staff.find((p) => p.id === staffId);
    this.assignNewTask(null, true, this.activeEmergencyTask.id);
  },
  triggerEmergency() {
    const template = this.scenario.emergencies[0];
    if (!template) return;
    const t = {
      id: 'EMG' + Date.now(),
      ...template,
      equipmentSequence: template.equipmentSequence.map((step) => ({ ...step })),
      status: 'pending',
    };
    this.emergencyQueue.push(t);
    this.flashEmergencyPanel();
    this.openEmergencyModal(t);
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
  updateEmergencies(gameDt) {
    this.emergencyQueue.forEach((t) => {
      if (t.status === 'pending' || t.status === 'in-progress') {
        t.timeLimit -= gameDt;
        if (this.activeEmergencyTask && this.activeEmergencyTask.id === t.id) {
          document.getElementById('emergencyTaskDeadline').innerHTML =
            `<strong>Deadline:</strong> ${this.formatTime(t.timeLimit, true)}`;
        }
        if (t.timeLimit <= 0) {
          if (t.status === 'pending') {
            t.status = 'failed';
            this.state.money -= t.penalty;
            this.showNotification(
              `Unassigned emergency task failed! Penalty: $${t.penalty}!`,
              'error',
            );
          } else if (t.status === 'in-progress') {
            const s = this.staff.find((s) => s.id === t.assignedTo);
            if (s && s.activeTask && s.activeTask.id === t.id) {
              this.failTask(s, s.activeTask);
            }
          }
          if (this.activeEmergencyTask && this.activeEmergencyTask.id === t.id) {
            this.closeAllModals();
          }
        }
      }
    });
    this.emergencyQueue = this.emergencyQueue.filter(
      (t) => t.status === 'pending' || t.status === 'in-progress',
    );
  },
  setStaffStatus(staffId, newStatus) {
    const p = this.staff[staffId];
    if (p.state === 'off') return;
    const oldStatus = p.state;
    if (p.state === newStatus) {
      p.state = 'idle';
    } else {
      if (p.activeTask) {
        this.failTask(p, p.activeTask);
      }
      p.state = newStatus;
    }
    this.logSandboxAction(`${p.name}'s status changed from ${oldStatus} to ${p.state}.`);
    this.updateAllPanels();
  },
  toggleShift(staffId) {
    const p = this.staff[staffId];
    if (p.state === 'off') {
      p.state = 'idle';
      p.energy = 100;
    } else if (p.state === 'idle' || p.state === 'break') {
      p.state = 'off';
      p.activeTask = null;
      const eq = this.equipment.find((e) => e.assignedTo === p.id);
      if (eq) {
        eq.inUse = false;
        eq.assignedTo = null;
      }
    }
    const actionMessage = `${p.name} has ${p.state === 'off' ? 'ended' : 'started'} their shift`;
    this.showNotification(actionMessage, 'info');
    this.logSandboxAction(actionMessage);
    this.updateAllPanels();
  },
  repairEquipment(eqId) {
    const eq = this.equipment[eqId];
    const cost = this.scenario.tuning.repairCost;
    if (this.state.money >= cost) {
      this.state.money -= cost;
      eq.condition = Math.min(100, eq.condition + this.scenario.tuning.repairAmount);
      const actionMessage = `${eq.name} repaired for $${cost}.`;
      this.showNotification(actionMessage, 'success');
      this.logSandboxAction(actionMessage);
      this.updateAllPanels();
    } else {
      this.showNotification('Insufficient funds!', 'error');
    }
  },
  calibrateEquipment(eqId) {
    const eq = this.equipment[eqId];
    const cost = this.scenario.tuning.calibrateCost;
    if (this.state.money >= cost) {
      this.state.money -= cost;
      eq.condition = Math.min(100, eq.condition + this.scenario.tuning.calibrateAmount);
      const actionMessage = `${eq.name} calibrated for $${cost}.`;
      this.showNotification(actionMessage, 'success');
      this.logSandboxAction(actionMessage);
      this.updateAllPanels();
    } else {
      this.showNotification('Insufficient funds!', 'error');
    }
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
  formatTime(totalSeconds, showSeconds = false) {
    if (totalSeconds < 0) totalSeconds = 0;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    if (showSeconds) {
      return `${m}m ${s.toString().padStart(2, '0')}s`;
    }
    if (h > 0) {
      return `${h}h ${m}m`;
    }
    if (m > 0) {
      return `${m}m ${s}s`;
    }
    return `${s}s`;
  },
  showNotification(message, type) {
    const n = document.createElement('div');
    n.className = 'notification';
    n.style.borderLeft = `4px solid ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'}`;
    n.innerHTML = `<div style="display:flex;align-items:center;gap:1rem;"><span style="font-size:20px;">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span><span>${message}</span></div>`;
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
    listEl.innerHTML = this.equipmentCatalog
      .map(
        (item) =>
          ` <div class="equipment-catalog-item"> <span style="font-size: 24px;">${item.icon}</span> <div class="info"> <strong>${item.name}</strong> <div style="font-size: 0.8rem; color: var(--text-light)">Requires Skill: ${item.skill}</div> </div> <div class="cost">$${item.cost}</div> <button class="btn btn-primary" onclick="Lab.buyEquipment('${item.id}')" ${this.state.money < item.cost ? 'disabled' : ''}>Buy</button> </div> `,
      )
      .join('');
  },
  buyEquipment(catalogId) {
    const item = this.equipmentCatalog.find((i) => i.id === catalogId);
    if (!item) return;
    if (this.state.money < item.cost) {
      this.showNotification('Not enough money to buy this equipment!', 'error');
      return;
    }
    const f = this.labFloor;
    let foundSpot = false;
    let newX = 0,
      newY = 0;
    for (let y = f.y + 1; y < f.y + f.h - 1 && !foundSpot; y++) {
      for (let x = f.x + 1; x < f.x + f.w - 1 && !foundSpot; x++) {
        const isOccupied = this.equipment.some(
          (eq) => Math.round(eq.x) === x && Math.round(eq.y) === y,
        );
        if (!isOccupied) {
          newX = x;
          newY = y;
          foundSpot = true;
        }
      }
    }
    if (foundSpot) {
      this.state.money -= item.cost;
      const newEquipment = {
        ...item,
        id: this.equipment.length,
        x: newX,
        y: newY,
        condition: 100,
        inUse: false,
        assignedTo: null,
        totalWorkTime: 0,
      };
      this.equipment.push(newEquipment);
      const actionMessage = `${item.name} purchased for $${item.cost} and placed in the lab.`;
      this.showNotification(actionMessage, 'success');
      this.logSandboxAction(actionMessage);
      this.updateAllPanels();
      this.closeAllModals();
    } else {
      this.showNotification('No available space in the lab to place new equipment!', 'error');
    }
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
      bar.innerHTML = `
            <span style="font-size:0.8rem;color:#475569;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${this.user.email}">👤 ${this.user.email}</span>
            <button onclick="Auth.logout()" style="padding:0.35rem 0.75rem;border:1px solid #e2e8f0;border-radius:8px;background:white;cursor:pointer;font-size:0.8rem;font-weight:600;color:#64748b;">Log out</button>`;
    } else {
      bar.innerHTML = `
            <span style="font-size:0.8rem;color:#64748b;background:#fef9c3;border:1px solid #fde047;padding:0.3rem 0.75rem;border-radius:20px;">Demo Mode</span>
            <a href="login.html" style="padding:0.35rem 0.75rem;border:none;border-radius:8px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:white;text-decoration:none;font-size:0.8rem;font-weight:600;">Sign In</a>`;
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

// --- Temporary bridge to the global scope --------------------------------
// This file is now an ES module, so top-level `const Lab` and `const Auth` are
// module-scoped and invisible to the inline onclick="Lab.…" handlers still in
// the markup. Without these two lines every one of those 25 handlers would
// silently stop working. They are deleted once the handlers become delegated
// data-action events, and that deletion is what proves the migration is done.
window.Lab = Lab;
window.Auth = Auth;
