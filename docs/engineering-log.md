# Engineering log

A record of the decisions taken while restructuring Polaris, the problems found
along the way, and how each conclusion was checked. Entries are in the order the
work happened.

Format: **context** (what was true before), **decision** (what was done),
**alternatives** (what was rejected and why), **verification** (what evidence
exists that it worked).

---

## 1. Establishing a baseline before changing anything

**Context.** The deployed site was serving a commit four behind `main`. Two of
the five pages had never been live at all — `/login.html` returned 404 in
production. The cause was the hosting project being connected to a different
GitHub repository than the one being worked in.

**Decision.** Reconnect the deployment, then verify the fix with a *preview*
build from a branch rather than by pushing to the default branch. Capture
reference screenshots and a reproduction of a known XSS vulnerability before any
code moved.

**Alternatives.** Pushing a test commit to `main` would have given the same
information. It was rejected because a deployment that *fails* cannot affect
production — the previous successful build keeps serving — but a deployment that
*succeeds and is wrong* replaces it immediately, and which of the two would
happen was unknown.

**Verification.** Preview build returned 200 on all four pages, including the
two that had never been live. Build log showed no framework detected and a
static serve from the repository root, confirming that the `package.json` naming
(`polaris-backend`, `main: server.js`) was not going to be misinterpreted as a
server deployment.

**Limitation found.** The screenshots are not pixel-comparable: initial staff
energy and equipment condition are randomised per load, and the simulated clock
is seeded from the system clock, so the time-of-day overlay changes the entire
palette depending on when the page is opened. This limitation is itself part of
the argument for entries 5 and 7.

---

## 2. Incremental migration behind a temporary global

**Context.** All application logic was inline in `lab-simulation.html`: 480
lines in a single `<script>`, written as one object literal with roughly 75
methods, several of them single lines of 2,700–3,600 characters.

**Decision.** Move the entire script into one module unchanged, with type
checking suppressed, and shrink it over subsequent commits — a strangler
migration, where the new structure is built around the old code rather than
replacing it in one step. Every commit leaves a working application.

**Alternatives.** A single rewrite was rejected: with no tests and no type
coverage, there would have been no way to distinguish a transcription error from
an intentional change.

**Risk handled.** Inline `onclick="Lab.…"` attributes worked only because a
top-level `const` in a *classic* script is reachable from the global scope. Once
the file became an ES module, that stopped being true and all 25 handlers would
have broken silently — no error, buttons simply dead. Two assignments to
`window` kept them working until the handlers were converted (entry 10), at
which point both were deleted.

**Verification.** Two specific risks were checked rather than assumed. ES
modules are always in strict mode, so an assignment to an undeclared variable —
legal before, a `ReferenceError` after — was ruled out with an ESLint `no-undef`
scan. Then end-to-end on a preview: no console errors, all panels, camera
controls, sandbox mode, task assignment and an emergency all functioning.

---

## 3. Formatting as a separate, provable step

**Context.** Several methods were single lines of up to 2,743 characters. Any
change to them appeared in `git diff` as "this one enormous line changed".

**Decision.** Run the formatter once, in its own commit containing nothing else.
498 lines became 1,672.

**Verification.** The production bundle was built before and after and compared:
byte-identical, including the content hash in the filename. Minification
discards formatting, so identical output is evidence that no code changed —
stronger than the argument that a formatter operates on a syntax tree and
therefore cannot alter semantics.

**Incident.** The first run silently did nothing. The ignore file contained the
entry `legacy`, intended for a root-level directory, but gitignore syntax
applies a pattern with no slash at *every* directory level, so it also matched
`src/legacy`. The check command reported "All matched files use Prettier code
style" — true, and meaningless, because zero files matched. Anchoring the
pattern fixed it.

**Related.** The HTML was formatted at the same time, while the markup was still
untouched, so that later steps which genuinely change markup produce diffs
showing only what they change. Prettier's `htmlWhitespaceSensitivity: "css"`
decides per element whether a line break would be visible: it kept
`$<span id="money">25000</span>` on one line, because breaking there renders
`$ 25000`, while splitting the children of a flex container is safe. That
specific case was checked rather than assumed.

---

## 4. Seven CSS classes that were never defined

**Context.** While extracting the stylesheet, seven class names generated by the
JavaScript turned out to have no definition anywhere: `equipment-card`,
`equipment-info`, `condition-bar`, `condition-fill`, `equipment-grid`,
`task-definition-list`, `btn-small`. Browsers ignore unknown classes silently,
so equipment cards rendered with no background or padding, and the condition bar
had no height and no `overflow: hidden`, which made its coloured fill invisible.
Repair and calibrate had always worked; there was simply no visible result.

**Decision.** Define them, in a commit of their own — the only commit in this
phase that intentionally changes what is on screen. Each was matched to its
existing equivalent rather than designed: `equipment-grid` mirrors `staff-list`,
`equipment-card` mirrors `staff-card`, and `condition-bar` was added to the
existing `.energy-bar, .progress-bar` rule so all three bars share one
definition and cannot drift apart.

**Alternatives.** Folding this into the stylesheet move was rejected, because
every other commit is verified by "nothing changed"; mixing a deliberate visual
change into a move destroys that check for both.

**Method note.** The initial detection was wrong in the other direction. A
regular expression anchored to a selector at the start of a line reported
`.energy-bar` as also undefined — but it is defined, inside a grouped selector,
which the pattern could not see. Re-checked with a plain substring count, and the
method was validated against classes known to exist before being trusted on
those that did not.

**Separately.** A flash animation for the emergency panel was fully written, with
an element carrying an id for no other purpose, but no code ever added the
class — so it had never once played. Now applied when an emergency is raised,
with a forced reflow so it restarts if a second arrives mid-animation.

---

## 5. Separating the lab's data from the simulation's rules

**Context.** The chemistry lab *was* the program. Staff names, machine
positions, task definitions and every tunable number were written among the code
that moves people and charges money.

**Decision.** Move everything true only of this lab into a scenario file, and
collect every model assumption into one `Tuning` object — starting budget,
training cost and duration, repair and calibration amounts, wear rates, event
rates.

**Rationale.** Two different kinds of thing had been written as one. "A person
may only start a task if they hold every required skill" is a rule, true in any
domain. "Dana Cohen knows Centrifuge Usage" is a fact about this lab. The
`Tuning` object is also what a later phase surfaces as an editable assumptions
panel, since a simulated verdict is only trustworthy if its inputs can be seen
and changed.

**Alternatives.** The plan had called for renaming several fields at the same
time. Deferred: moving data is verifiable by inspection, whereas renaming a
field means editing every use across 1,500 lines, which is a change to logic.
Combining them would have produced a diff where a move and a mistake look the
same.

**Found.** Three duplications where two copies of one number could drift: the
starting budget written in both the markup and the state object; the camera
reset repeating the initial coordinates; and the entrance door appended to the
props list by the function that builds walls.

---

## 6. Seeded randomness, and a frame-rate dependency

**Context.** Six unseeded `Math.random()` calls. Two of them were evaluated once
per *animation frame* rather than per unit of simulated time.

**Decision.** Route all randomness through a seeded generator whose state is a
single readable number, and convert the two probability rolls to rates per
second using the exponential survival function, `1 − exp(−rate·dt)`.

**Impact of the bug.** The emergency roll was `Math.random() < 0.0005` per
frame: 1.80 emergencies per simulated minute at 60 Hz, and 4.32 at 144 Hz. The
viewer's display was an undeclared input to the simulation.

**Alternatives.** The linear approximation `rate × dt` was rejected: it is only
valid while small and exceeds 1 outright for large steps, which matters because
later work steps a simulated week in coarse ticks rather than sixtieths of a
second.

**Verification.** The new rates were calibrated against the old constants at the
refresh rate they were implicitly tuned on, and the arithmetic checked: at 60 fps
the new formula yields 0.0004999 against the old 0.0005. A `?seed=` parameter
makes any run replayable, and the seed is logged at startup; reloading twice with
the same seed produces identical staff energies and equipment conditions, and a
different seed produces different ones.

**Also.** The same commit replaced five copy-pasted instances of the
skill-qualification predicate with one shared rule, and removed a tuning
constant that had been hardcoded inside display text ("Cost: $300"), where it
would have silently disagreed with the configuration.

---

## 7. Extracting the canvas renderer

**Context.** The drawing code — twelve methods, roughly 350 lines — was mixed in
with the simulation.

**Decision.** Move it verbatim into its own module behind
`createRenderer(canvas) → { resize, render(view), getScreenCoords }`, then
extract the colour palette in a *second* commit, then type it in a third. The
renderer became a pure consumer: it reads a view and draws it, and never changes
the world, decides anything, or updates a panel.

**Method.** The moved code referred to `this.ctx`, `this.camera`,
`this.labFloor`. Rather than edit 350 lines of drawing code — which would have
made the move unreviewable — those names were kept as getters reading through to
the current view. The view holds live references rather than copies, so there is
no per-frame copying and the hover hit-test still sees the current camera rather
than the previous frame's.

**Why three commits.** This was the highest visual-risk change in the phase, and
splitting it meant any drift could be attributed to one of the three rather than
guessed at.

### Incident: a silent `NaN`

Idle staff stopped being drawn, with no error. `drawStaff` computes a small
vertical bob from the animation clock, which lived on the simulation object. Once
the method moved, that reference resolved to `undefined`, `Math.sin(undefined)`
produced `NaN`, and every shape was drawn at `NaN` coordinates. **Canvas
silently ignores non-finite geometry**: no exception, nothing painted. Only staff
that were idle without a task took that branch — exactly those that should have
been visible.

Diagnosis came from noticing that the two symptoms (invisible, and apparently
not moving) share exactly one cause — a staff member being off-shift — and ruling
that out. The clock is now passed in through the view rather than read from a
global, which keeps drawing a pure function of its input.

The underlying cause was that the dependency audit had been done by sampling
rather than exhaustively. It was redone mechanically, comparing every `this.X`
in the renderer against what the view provides.

### What typing the module surfaced

Removing the type-checking suppression turned both of the above into compile
errors and revealed three further problems:

- **Props are drawn wrong.** The scene builds its draw list with
  `{ ...prop, type: 'prop' }`, which overwrites each prop's own kind — a prop is
  already tagged `desk`, `shelf`, `plant`, `coffee` or `door`. The shelf branch
  and the icon-only branch of `drawProp` are therefore unreachable, and every
  prop renders as a desk with its icon on top. Found structurally:
  `Prop & { type: 'prop' }` collapses to `never`. **Left unfixed deliberately**,
  because this phase changes no behaviour and the fix alters what is on screen.
- **A boolean does not narrow a union.** `const isT = task.type === 'training'`
  followed by a ternary left every subsequent property access unchecked.
- **Several array lookups could miss** under `noUncheckedIndexedAccess`.

---

## 8. The simulation engine

**Context.** The update loop advanced the world *and* rebuilt four HTML panels
roughly sixty times a second, and the assignment code called the notification
function from inside the business rules. The simulation could not run without a
browser attached.

**Decision.** Extract it behind four functions: `createWorld(scenario, seed,
startMinutes)`, `tick(world, dt, options)`, `applyCommand(world, command)` and
`cloneWorld(world)`. The simulation state holds only simulation facts; camera,
hover, selection and sandbox mode are properties of *looking at* a lab and stay
with the view.

**Mutation over immutability.** `tick` and `applyCommand` mutate the world and
return events, rather than returning a new world. Later work runs hundreds of
simulated weeks, and allocating a fresh state per step would mean tens of
millions of allocations. Determinism does not require immutability; it requires
that output depends only on `(world, dt, command)`.

**That property is enforced by tooling, not convention.** ESLint rejects
`Math.random`, `Date.now`, `new Date`, `window`, `document` and `performance`
anywhere in the engine directories, each with a message explaining why. Verified
by writing a file that violates two of them and confirming it fails.

**Events carry data, not sentences.** The engine reports
`{ type: 'task-completed', staffName, reward }`; the view decides the wording and
the colour. Refusals work the same way, as `{ rejected, reason }`. This is what
allows a headless run, and it makes later features consumers of the event stream
rather than new branches inside the rules.

**Bugs fixed by the extraction.**

- Marking someone sick during training called a failure path that charged
  `task.penalty` — absent on a training, so the budget became `NaN` — and indexed
  an equipment sequence that does not exist, so it threw. Typing the active task
  as a genuine union of a job and a training made both impossible.
- The equipment panel passed array *positions* to repair and calibrate, which
  targets the wrong machine once anything is removed.
- The task modal indexed the staff array by what is actually a staff id.
- Buying equipment set the new id to the array length, which collides after any
  removal.

**Regression introduced and fixed.** The original refused to mark an off-duty
person sick; that guard was dropped in the move, so clearing "sick" afterwards
set them to idle and quietly put them back on shift. Restored, and it now gives a
reason rather than failing silently as the original did.

### Open design question, deliberately not answered here

The product requires that an operator be free while an instrument is still
running — one instrument needs 60 minutes of preparation and 90 minutes of
machine time, and a cell culture involves a 48-hour incubation. A task step
currently locks one person and one machine together for a single duration and
cannot express this.

**Decision: defer to the next phase**, where work items become first-class
entities. The same requirements also call for weekly job arrivals, a backlog
measure, per-job deadlines and an automatic dispatcher, none of which can be
fields on a person either. All of them want the same change, so it is one piece
of work rather than four patches onto a model that would then be replaced.

Confirmed that this phase does not make it harder: equipment occupancy is
already explicit state, events are additive, and the code that would need
rewriting is roughly forty lines in one module rather than spread across a
1,500-line file.

---

## 9. Closing the stored-XSS hole

**Context.** The UI built markup from template strings and assigned it with
`innerHTML`, which parses its input as HTML rather than treating it as text.
Staff names, the business name and task titles all arrive from the onboarding
form by way of the database, so a stored name containing a tag executed in the
browser of whoever viewed the record.

**Decision.** A 25-line tagged template that escapes every interpolation. The
guarantee is enforced by the type system: it returns a branded type, and the
only function that writes markup to the document accepts nothing else, so an
unescaped string cannot reach `innerHTML` by accident. Deliberately trusted
markup must say so explicitly.

**Alternatives.** A framework would give an identical escaping guarantee. It was
rejected on diff size: adopting one means rewriting every template across
eighteen call sites, in a change whose premise is that nothing visible moves. The
tagged template produces the same string the existing code already produced, so
the conversion was mechanical.

**What it broke, correctly.** The staff card built its skill tags as a *joined
string of markup* and interpolated that, so the helper escaped it and the tags
appeared as literal text. The fix is an array of fragments, which the helper
flattens unescaped. The sandbox history badge had the same shape. Everything else
interpolates plain text, which is exactly what should be escaped.

**Not covered, and documented in the module rather than assumed.** Escaping
quotes makes a *quoted attribute* safe but does not make `href` safe against a
`javascript:` URL, nor `style` safe against CSS injection. Nothing may be
interpolated into a script context.

**Verification.** Reproduced by hand with the original payload — before, an
alert fired and the browser attempted to load the image; after, the identical
input renders as literal text with no element created. Pinned by tests
(entry 11).

---

## 10. Event delegation

**Context.** 26 inline event attributes, 14 in markup and 12 generated into
panel templates.

**Decision.** One listener dispatching on a `data-action` attribute.

**Rationale.** Not a style preference. The panels are rebuilt by assigning
`innerHTML`, which destroys their children, so a listener attached to a generated
button would be silently dropped on the next rebuild. A single listener on an
ancestor survives every re-render.

**Consequences worth recording.**

- `event.stopPropagation()` disappeared and was not replaced. A Save button sits
  inside a panel header that toggles on click and previously had to stop the
  event reaching it; `closest('[data-action]')` returns the innermost match, so
  the button wins. Delegation is simpler here, not merely equivalent.
- `mouseenter` and `mouseleave` do not bubble and cannot be delegated at all. The
  hover highlight uses `mouseover`/`mouseout` with a `relatedTarget` check so the
  pointer crossing between a card's own children does not re-fire.
- `Escape` now closes any open modal — keyboard parity the inline handlers never
  had.

**Verification.** Checked mechanically that every action used in markup or
templates has a handler and every handler is used: 17 each, no gaps. The two
globals that had held the inline handlers up were deleted, and confirmed absent
from the built bundle.

### Incident: an undefined reference that shipped

A helper was called in one commit and imported in the next, so for one commit any
emergency raised threw a `ReferenceError`. The build passed, the type checker was
suppressed for that file, and the linter excluded the directory — three tools,
none of them looking.

**Decision.** Rather than a test for the symptom, close the class: a second,
deliberately minimal lint configuration covers that directory for exactly one
rule, `no-undef`, wired into the lint script. It needs no type information.
Confirmed by removing the import again and watching it report all four call
sites.

**Reflection.** The exclusion was reasonable when the file was 1,500 lines of
untouched code, and stopped being reasonable once it was edited daily. A
quarantine should be as narrow as its justification, and the justification here
was "type information is unavailable" — which says nothing about rules that need
none.

---

## 11. Tests

**Context.** Three claims made by this work — runs are reproducible, the crash is
fixed, the XSS is closed — rested on having checked each once by hand.

**Decision.** 26 tests in two files. The test environment is deliberately
`node`: the engine is headless by design, so a test needing a browser would
signal that something had leaked across the boundary.

**Coverage.** Determinism is checked by fingerprinting money, clock, generator
position, metrics and every entity after a thousand ticks and comparing two runs
from one seed; a different seed must differ. A separate case steps the same
simulated minute in one-second and tenth-of-a-second slices and requires the
clock to agree, which is the property the rate conversion in entry 6 bought. The
crash case starts a training, marks the person sick, and asserts no throw, a
finite unchanged budget, and that the machine is released. The escaping tests
render the actual attack payload and assert no element is created.

**Verification of the tests themselves.** Both fixes were reverted and the suite
re-run: unescaping the template fails 4 tests, removing the training guard fails
2. A test that has never failed carries no information.

**Enabled by entry 8.** Before the engine was separated, testing any of this
required a browser, a canvas and an animation frame.

---

## 12. Repository cleanup and honest degradation

**Context.** An abandoned 67 kB fork of the simulation was still present and
publicly reachable. Two backends implemented the same ten endpoints. The manifest
described an Express server and carried seven runtime dependencies that a static
site does not use.

**Decisions.**

- The abandoned fork was deleted; it remains recoverable from history.
- Both backends were moved to `legacy/` rather than deleted. They are the only
  written definition of ten endpoints, four table shapes and the token scheme the
  front end already expects, and the next phase rebuilds that surface. Their
  README records three problems to fix rather than port, including an
  administrative endpoint with no authentication that returns the entire waitlist.
- The manifest became a front-end manifest with no runtime dependencies.
  Production vulnerabilities went from three to zero; all three came from the
  removed backend packages.

**Graceful degradation.** Merging makes the sign-in and setup pages live for the
first time while every API path still returns 404. All three API-dependent pages
previously behaved as though the server were merely misbehaving — one reported
"Could not reach the server. Is it running?", a message written for a developer.
Each now states plainly that accounts are not available yet and routes to the
working demo, and the waitlist form admits that an address was not saved rather
than silently discarding it. No contact address is published: an unattended inbox
is its own broken promise, and a published address is harvested.

---

## 13. Known limitations carried forward

Recorded rather than fixed, with the reasoning for each.

- **The energy metric is invented.** It drains, refills and sends people on
  breaks, but is not grounded in anything measurable, and it gates nothing. The
  next phase replaces it with hours worked, overtime, and a fatigue effect on
  duration and error rate. Removing it earlier would have changed the interface
  before a replacement existed.
- **An operator and a machine are locked together** — see entry 8.
- **Purchased equipment cannot relieve a bottleneck.** Task steps match machines
  by exact name, and the shop sells names (`Microscope B`, `PCR Machine II`,
  `Auto-Sampler`) that no task step asks for. Buying a second machine of the same
  name also produces two entries of which only the first is ever selected, since
  the lookup returns the first exact match. Capacity is modelled as a named thing
  rather than a count of interchangeable things. This blocks a planned comparison
  of "lease a second instrument", and the fix belongs with making work items
  first-class: a step should require a *capability*, and any machine providing it
  should be usable.
- **Time units are inconsistent.** A task step's duration counts down in
  simulated seconds but is labelled "min" in the interface, while the clock
  advances half a simulated minute per second. Preserved deliberately: changing
  it changes how the simulation feels, and there were no tests to catch that at
  the time. It belongs with the explicit-assumptions work, where recalibrating is
  the point.
- **Props render as desks** — see entry 7.
- **The view layer is not yet split into typed modules.** It holds no simulation
  rules: it reads the world, renders it, and turns clicks into commands. Splitting
  it is the next structural piece of work and was deliberately left out of this
  phase.

---

## 14. Phase 1 retrospective

Merged to `main` and deployed on 9 October 2026.

### What it set out to do, and whether it did it

The goal was not features. It was to make three things possible that were not:
running the simulation without a browser, reproducing a run, and rendering
untrusted text safely. All three hold now, and each is enforced by tooling
rather than by intention — a lint rule for the first, a seeded generator and a
test for the second, a branded type for the third.

| | Before | After |
|---|---|---|
| Entry file | 768 lines, 75 kB | 221 lines, 8.5 kB |
| Simulation | inline, required a browser | `src/engine`, headless |
| Tests | 0 | 26 |
| Inline event handlers | 26 | 0 |
| Unescaped `innerHTML` sites | 26 | 0 |
| Production dependency vulnerabilities | 3 | 0 |
| Sidebar rebuild rate | ~240 subtree reparses/second | 4/second, plus on events |

40 commits. The deployment was also four commits stale at the start, serving a
build from September, and two of the five pages had never been live at all.

### The pattern in the defects found

Nine bugs surfaced. Almost none were logic errors; they were failures of
*visibility*:

- A frame-rate dependency, because an undeclared input (the monitor's refresh
  rate) influenced the result.
- A `NaN` that stopped anything being drawn, because canvas discards non-finite
  geometry without complaint.
- Seven CSS classes with no definition, because browsers ignore unknown classes.
- An animation that had never played, because nothing ever added its class.
- An undefined reference that reached production, because the file it was in was
  excluded from both the type checker and the linter.
- Equipment matched by name, so purchased machines can never be used.

The common shape is a system that fails by doing nothing rather than by
reporting. Every fix that stuck was therefore a tooling change — a lint rule, a
type, a test — rather than a correction in place. The three corrections made
without one (the renderer's missing clock, the shadowed palette array, the
dropped off-shift guard) were each caught by hand afterwards, which is the point.

### What was rejected, and held up

Several decisions traded short-term convenience for reviewability, and all were
worth it:

- Moving code verbatim before improving it, so that each move could be verified
  by comparing output rather than by reading a diff.
- Keeping formatting changes in commits of their own.
- Suppressing type checking on the file being migrated, scoped and time-boxed —
  though the scope was drawn too wide, and that cost a production bug (entry 10).
- Deferring renames, unit corrections and one visual fix rather than bundling
  them into moves.

### What Phase 1 did not do

The view layer is still one 1,125-line file. It holds no simulation rules — it
reads the world, renders it, and turns clicks into commands — but it is not yet
split into typed modules. Three secondary pages keep their inline scripts, with
only enough work done that nothing live is a dead end.

The limitations carried forward are listed in entry 13. The two that most
constrain what comes next are that work items are fields on a person rather than
entities in their own right, and that equipment capacity is modelled as a name
rather than a count.

---

# Phase 2 — the simulation model

## 15. A working-time calendar

**Context.** The clock counted minutes past midnight and wrapped, so the engine could not tell
Monday from Thursday. Everything Phase 2 needs is unanswerable against that: a deadline of "two
working days", overtime "after 45 hours in a week", a shift that runs 08:00–16:00 Sunday to
Thursday, a four-week horizon with the first week discarded.

**Decision.** Build the calendar first and alone, as pure arithmetic over one monotonic minute
count where minute 0 is Sunday 00:00 — no world, no state, no randomness. Then, separately, replace
the world's wrapping clock with an absolute one, deriving the old minutes-past-midnight value from
it so the HUD and time-of-day overlay need no change.

**Alternatives.** Keeping the wrapped clock and carrying a separate day counter alongside it was
rejected: two representations of the same quantity invite them to disagree, and every consumer would
have to know which one to ask. Deriving the wrapped value from the absolute one keeps a single source
of truth.

**Three judgements it encodes**, each recorded as data rather than buried in a function, because each
is a question for the lab manager rather than a fact:

- "Two working days" means close of business on the second working day, not 960 minutes of labour.
  That is what a client means, and it makes the deadline independent of whether a job arrived at
  09:00 or 15:55 — otherwise an afternoon arrival is quietly penalised.
- A job arriving outside working hours starts its clock at the next opening, so arriving at 22:00 on
  a Thursday does not consume the weekend.
- Rush deadlines are wall-clock hours, nights included. That is what makes them hard, and it means
  one arriving on a Thursday afternoon can be impossible to meet. That is a property of the lab
  worth reporting rather than smoothing away.

Closing time is exclusive, so the lab is shut at exactly 16:00. This makes closing a single
unambiguous instant rather than a minute that is both open and closed, which is what will let the
slice loop in the next entry stop exactly on it.

**Verification.** 48 tests on the calendar, 3 on the clock change. Four mutations were introduced to
check the tests were load-bearing rather than decorative:

| Mutation | Tests failed |
|---|---|
| Closing time made inclusive | 10 |
| The arrival-day counting rule ignored | 1 |
| `nextOpen` loses its wait-until-morning case | 2 |
| A negative overlap left unclamped | **0** |

The fourth exposed a real gap: no test covered a span falling entirely between two shifts — 17:00
Monday to 07:00 Tuesday touches two working days but contains no working minutes, and both days
contribute a negative overlap that must not be summed. Two tests were added and the mutation now
fails. The lesson is the one that keeps recurring in this project: a test suite that has never been
attacked tells you nothing about what it would catch.

---

## 16. Line endings

**Context.** After a branch checkout, `format:check` reported every file in the repository as
incorrectly formatted while `git diff` showed no changes, and every commit printed a warning about
line endings being replaced.

**Cause.** Git stores text as LF, but `core.autocrlf=true` on Windows converts it to CRLF on
checkout, and no `.gitattributes` overrode that. The formatter's default is LF. The condition had
existed all along and only surfaced when the working tree was re-materialised.

**Decision.** `* text=auto eol=lf` in `.gitattributes`, fixing it in the repository rather than in
one machine's git configuration, so a fresh clone is correct without anyone being told. Binary types
are marked explicitly so they are never translated.

**Why it mattered enough to stop for.** Continuous integration is about to run `format:check` as a
gate. Left alone it would have failed on every platform-dependent checkout, and the obvious reading
of that failure — "someone forgot to format" — would have been wrong, which is the kind of false
signal that teaches people to ignore a gate.

---

## 17. A query seam between the model and the interface

**Context.** The view and the renderer read the simulation's internal shapes directly. The canvas
progress bar computed itself from `person.activeTask.equipmentSequence[person.taskStep].duration`.
Work is about to stop being a field on a person and become an entity of its own, which would break
every one of those reads — scattered through 1,125 untyped lines, with nothing to report one that
had been missed.

**Decision.** Insert a thin layer the interface asks *questions* through: what is this person doing,
what work is in progress, who is free, what time is it. The answers live in one typed module and
return plain display data — strings, numbers, booleans — holding no reference into the world.

**Alternatives.** Changing the model first and then repairing the view was rejected: the repair would
have been a search for every affected read with no mechanical way to know when it was complete, and
any miss would surface as a panel quietly showing nothing rather than as an error. Typing the view
first was also rejected, as the visual redesign replaces it regardless.

**Why the returned data is detached.** Handing back live references would be cheaper, but a panel
holding one can mutate the simulation by accident — and the direction of the dependency is the whole
point of the seam. A test asserts that writing to a returned object changes nothing in the world.

**A detail worth recording.** Two functions take a `world` parameter they do not yet use, because the
next step resolves the job from the world rather than the person. Accepting it now means each call
site is written once instead of twice, and the unused parameter is marked so the linter does not
object.

**Verification.** 15 tests pin the contract rather than the implementation: what the interface may
ask and what shape it receives. Those are the assertions that will say whether the panels still work
once the answers are rewritten against a different model. Mechanically confirmed by both the view and
the renderer now containing zero references to `activeTask`, `taskStep` or `taskTimer`.

**Two test failures worth keeping.** The first draft advanced a fixed 2,000 ticks to observe work in
progress, which overshot and completed the task — a fixed tick count silently depends on durations
that are about to change, so it now advances until the work actually starts. The second asserted
progress above zero immediately after a step began, when the correct value at that instant is exactly
zero. Both were wrong tests rather than wrong code, which is its own useful signal: an assertion
written from an assumption about timing rather than from the model.

---

## 18. Minutes, and an event-driven loop

**Context.** The loop advanced everything by whatever slice of time it was handed. A large step
therefore stepped over things: a task finishing partway through lost the remainder, a walker jumped
past their destination, and two random events were dice rolled once per call rather than scheduled.
Stepping a day at a time gave different answers from stepping a sixtieth of a second at a time.

**Why that matters more than it sounds.** The live view steps finely; the batch runner must step
coarsely to finish hundreds of simulated months in seconds. If the two disagree, the numbers on a
verdict card describe a simulation nobody ever watched — and the disagreement is silent, because
each run looks entirely reasonable on its own.

**Decision.** Clamp each slice to the next thing that actually happens: a step completing, someone
reaching a machine, a deadline falling due, a scheduled event. One iteration per event, so nothing
is ever stepped over. Separately, make simulated minutes the engine's unit, which also resolves the
inconsistency carried over from Phase 1 where a step authored as `duration: 20` was counted in
seconds while every label said "min".

**The dice become schedules.** Asking "did this happen during the last slice?" has an answer that
depends on how often it is asked. Drawing the wait until the next occurrence once, from the
exponential distribution, does not. This is the same mechanism job arrivals will use.

### What the invariance test found

Four ordering and threshold errors, each of which made an outcome depend on step size, and none of
which would have been visible by inspection:

- A newly raised deadline was charged the whole slice it was born in. Existing work is now ticked
  before anything new appears.
- Machines were charged for a slice after people acted in it, so a machine switched on at the last
  instant was billed for the whole slice.
- Work started when rounded coordinates matched — true within half a tile, rather than on arrival.
  Arrival is an instant the loop lands on exactly; a rounded position is not.
- Arrival was *detected* one slice after it happened, and that slice's length varies. Movement now
  runs before the work logic, so work begins at the instant of arrival.

Two further bugs were floating-point dust: a timer at 1e-17 was not worth clamping to and so
received a whole extra step, and landing exactly on the arrival radius leaves a distance a hair
outside it. Both are fixed by one tolerant definition of arrival used by the movement, the arrival
test and the event clamp alike.

### Correcting the claim that was made for this work

The plan said this step would make coarse and fine stepping **bit-identical**. That was wrong, and
the test proved it: divergence appears in the first simulated minute, where the two clocks read 481
and 480.9999999999991. Sixty additions of one sixtieth do not equal one addition of one in binary
floating point, and no amount of clamping changes that.

The guarantee the loop does provide is sharper and more useful: **no event is ever stepped over**, so
divergence is bounded by floating-point accumulation rather than by logic. The test therefore asserts
two different things. Everything discrete — who is doing what, which machines are busy, how many
events fired, and the exact position of the random number generator — must match *exactly*, because
the reported metrics are built from those. Everything continuous must match to a tolerance far
tighter than any decision would turn on.

That distinction is worth more than the original claim. "Identical" would have been unachievable and
quietly abandoned; "no event is stepped over, and here is the arithmetic bound on what remains" is
both true and testable.

**Verification.** Eight tests across step sizes from a sixtieth of a second to a whole day.
Confirmed load-bearing: removing the clamping fails six of them. One pre-existing test had to be
updated, because work now begins the instant someone arrives and continues through the rest of the
slice rather than discarding the remainder — the test had been asserting the wasteful behaviour.

---

## 19. Incident — a shared random sequence biased every comparison

The first entry in this log recorded as an incident rather than a decision, because it is the first
defect found here that would have produced *confidently wrong output* rather than a visible failure.
Nothing was deployed with it reaching a user, since the comparison feature it invalidates does not
exist yet — but it was latent in `main`, and the shape of the failure is worth recording in full.

| | |
|---|---|
| **Severity** | Would have invalidated every number Phase 4 produces |
| **Introduced** | Phase 1, step 6 (seeded randomness), present on `main` |
| **Detected** | Phase 2, verifying A2 — as a side effect of investigating an unrelated change |
| **Detected by** | A reviewer noticing that eight numbers on screen had changed |
| **Time to detect** | Roughly three weeks, across two phases |
| **Impact** | None realised; the affected feature was not yet built |
| **Root cause** | One generator shared by every random value, consumed in creation order |
| **Resolution** | One named, independently derived sequence per entity and per concern |
| **Class of failure** | Silently biased output. No crash, no exception, no wrong-looking number |

**Why this one is worth an incident record.** Every other defect in this log announced itself — a
crash, a `NaN`, a blank canvas, a `ReferenceError`. This one produces plausible numbers with a
plausible range around them, and the range is *narrower* than the truth, so the output looks more
trustworthy as it becomes more wrong. There is no assertion that would have caught it after the fact
and no amount of staring at a verdict card that would have revealed it. The only defences are the
structural one (separate streams) and the test that checks the structure holds.

**It was found by a human reading output, not by a test.** The eight starting energies on screen had
changed, and the question "is that intended?" was what opened the thread. No automated check in the
project was looking at seeded values at all. That is the honest detection story and the reason the
test now exists.

**Context.** Verifying A2 on the preview surfaced a change nobody had asked for: with `?seed=42` the
eight starting energies had become `92, 97, 83, 85, 97, 84, 94, 83` where they had been
`92, 88, 97, 93, 83, 90, 85, 92`. The new values were the old ones taken every other position, which
pointed at the cause — creating a person now draws twice from the generator rather than once, because
A2 schedules each person's next idle movement in advance instead of rolling for it every tick.

That part was expected and harmless. Looking into it, though, exposed something that was not.

A single generator fed every random value in the project: starting energies, starting machine
conditions, the schedule of incidents. One sequence, consumed in creation order. So the *number* of
draws any one thing makes shifts every draw after it. A throwaway test created the lab twice, once
with an extra technician appended, and compared:

```
machine condition, no hire : 90.60  88.32  70.12  84.12  95.12  71.54  87.77  70.95  78.01
machine condition, one hire: 70.12  84.12  95.12  71.54  87.77  70.95  78.01  71.85  75.57
first incident due, no hire : minute 482.126
first incident due, one hire: minute 531.013
```

Every machine starts in a different condition, and the first incident moves by forty-nine minutes.
Hiring one person had changed the weather.

This matters because of what the product is for. Phase 4 answers "should I hire a technician?" by
running the lab with and without the hire and reporting the difference between them. If the two runs
are two different labs, that difference is luck, and the tool reports it as the effect of hiring —
confidently, with a plausible-looking range around it. The failure is invisible from the output. A
verdict card built on this would be fiction, and there would be nothing in it to suggest so.

**Decision.** Every entity and every concern draws from its own named sequence, derived from the one
seed: `deriveSeed(seed, 'operations')`, `deriveSeed(seed, 'staff:3')`, `deriveSeed(seed,
'equipment:5')`. FNV-1a over the label, mixed with the seed — not a strong hash, and it does not need
to be, because all it has to do is spread similar labels apart. Each person then carries their own
generator position on the world (`Staff.rngState`), so movement during the run draws from the person
rather than from the lab.

A run is still reproducible from a single seed. What changes is that the seed now names a family of
independent sequences instead of one shared queue.

**Alternatives considered.**

- *Leave it, and fix it in B4 where fair comparison is actually required.* Rejected: A3 adds job
  arrivals, which is the largest consumer of randomness in the design. Fixing this afterwards means
  re-deriving every seeded value in the project a second time, and in the interim every test written
  against arrivals would be anchored to numbers that are about to move.
- *One generator per concern (demand, operations) but not per entity.* This is what the plan called
  for, and it is not sufficient. Staffing is a decision variable, so staff must not share a sequence
  with anything a comparison holds fixed — including each other, since two options may differ in how
  many people exist.
- *Draw lazily, on first use, instead of at creation.* Does not help. The order of first use depends
  on the simulation's own behaviour, which is exactly what the comparison is trying to measure.

**Verification.** A new `fairness.test.ts`, nine tests, in two halves. One half asserts that adding a
person leaves every machine's condition, the incident schedule and the other people byte-for-byte
unchanged — including after a simulated fortnight, by which point an unisolated sequence has drifted
thousands of draws apart — and that leasing an instrument leaves the people unchanged. The other half
asserts that the sequences are still sequences: every person starts with a different energy, every
machine with a different condition, and a different seed still produces a different lab. Without that
second half the first would pass just as happily if every stream had collapsed onto one value.

Confirmed load-bearing by putting the shared sequence back: creation-time sharing fails four of the
nine, and sharing only the movement draws fails the fortnight test specifically.

Two things about that mutation test are worth recording, because both were initially wrong and both
would have left a test that could not fail.

- The first two attempts to reintroduce the bug did not reintroduce it. Reading the lab's generator
  position and writing the result back to the person is not sharing, and writing back to the lab is
  not either, because `advance` overwrites that position from its own local generator when it
  returns. Only threading the generator *object* down through the call chain — which is what the code
  did before the fix — actually restores the defect. A mutation that the tests survive is not
  evidence the tests are weak; it can just as easily mean the mutation missed.
- The scenario rosters only the first six of eight people, so a ninth appended hire is off duty, and
  an off-duty person draws nothing. The fortnight test could not see the movement sequence at all
  until the baseline was changed to roster everyone, so that the hire is genuinely the only person
  added to the floor.

**One pre-existing test had to be rewritten.** It raised the incident rate to fifty an hour after
creating the lab and then stepped twenty minutes, expecting one. Since A2 the schedule is drawn once
at creation, so raising the rate afterwards cannot move an event already on the books; it had been
passing only because that one seed happened to schedule an incident two minutes in. It now brings the
due instant forward, which is the thing the code actually waits for. Worth noting as a class: when
timing moves from "rolled every tick" to "scheduled once", any test that manipulates a rate has
quietly stopped testing what it claims.

**Seeded outputs have changed and will not match earlier screenshots.** This is expected, once from
scheduling movement in advance and again from the per-entity sequences. The seed-to-lab mapping is
not a stable interface and nothing is pinned to it; reproducibility means the same seed gives the same
run, not that it gives the same run as last week's build.

### Follow-up — whether adjacent seeds produce correlated streams

Review raised a specific doubt on the fix: under both seed 42 and seed 43, the first person's energy
rounded to 95 on screen. The underlying values are `95.71796610` and `95.70652576` — agreement to
three decimal places, not a display coincidence. Since a batch run numbers its seeds consecutively,
a systematic correlation between adjacent seeds would mean three hundred runs were three hundred
near-copies, and the reported P10–P90 range would be far too narrow. Narrow and confident, which is
the same failure mode as the incident above.

The doubt is well founded in principle. `deriveSeed` is FNV-1a, which is a fast hash and not a strong
one, and integer multiplication propagates carries only upward — so the low bits of an FNV hash are
its worst-mixed part, and seeds differing only in the low bits are exactly what a batch run produces.

Measured over seeds 1–1000, taking the first draw of the `staff:0` stream:

| Statistic | Measured | Expected | 3σ band |
|---|---|---|---|
| Lag-1 correlation | −0.0286 | 0 | ±0.095 |
| Lag-2 correlation | −0.0453 | 0 | ±0.095 |
| `staff:0` vs `staff:1` | +0.0406 | 0 | ±0.095 |
| `staff:0` vs `equipment:0` | −0.0379 | 0 | ±0.095 |
| Mean | 0.5169 | 0.5 | — |
| Decile counts | 82 95 92 113 95 105 102 106 97 113 | 100 each | ±28 |
| Distinct derived seeds | 1000 of 1000 | 1000 | — |
| Adjacent pairs within 0.0005 | 2 of 999 | ~1 | — |

Everything sits inside noise. Two independent uniform draws land within 0.0005 of each other about
once per thousand pairs; two such pairs were observed, and 42/43 is one of them. So the observation
is a coincidence — but it was not possible to say so until it was measured, and the measurement is
now a test rather than a one-off.

Five tests added, bounds set at roughly three standard errors rather than fitted to the observed
values. They are deterministic despite looking statistical, because nothing in them draws from the
clock.

**What the mutation testing showed, including where it was unflattering.** Four deliberate breakages:

| Mutation | Tests failed |
|---|---|
| A. `deriveSeed` ignores the label | 3 — distinctness ×2, cross-stream correlation |
| B. `deriveSeed` becomes `seed * 31 + label.length` | 3 — the same three |
| C. mulberry32's avalanche stripped, output is its counter | 1 — cross-stream correlation |
| D. B and C together | 6 — all of the above plus lag-1, deciles, adjacent pairs |

The useful finding is in the gap between C and D. The lag-1, decile and adjacent-pair tests survive
a weak derivation *and* survive a weak generator, and only fail when both are weak at once — because
each layer's mixing covers for the other's absence. FNV-1a spreads consecutive seeds far apart, so
even a generator that returns its own counter produces uncorrelated first draws; and mulberry32's
avalanche is strong enough that even consecutive derived seeds produce uncorrelated draws.

So those three tests are a backstop, not a guard: they are load-bearing only against simultaneous
degradation of both layers. That is worth less than it first appeared, and recording it is more
useful than letting a green suite imply a stronger guarantee than it gives. The genuinely
load-bearing checks are the cross-stream correlation and the per-entity distinctness tests, which
fail under every one of the four mutations between them.

Mutation B also exposed something the measurement alone would not have: `staff:0` and `staff:1` are
the same length, so any derivation keyed on label *length* rather than content collapses them onto
one sequence. The cross-stream test catches that; a test that only compared `staff:0` against
`equipment:0` would not have.

---

## 20. Work becomes a thing that exists on its own

**Context.** Work did not exist until a person was told to do it. The lab held three *recipes* and a
human picked one up out of nothing, so there was no queue, nothing waiting, nothing late, and no
backlog to measure. "Are we falling behind?" — the question the product exists to answer — was not
expressible against the model.

**Decision.** Samples arrive on their own. A `Job` is one real instance of a `WorkType`: it arrived
at a particular minute, is due at a particular minute, and holds its own progress as *remaining*
counters. Progress moving off the person and onto the job is what makes every interruption free —
shift close, sickness, reassignment and, later, a breakdown are all just "stop decrementing", with no
code of their own.

Split into three commits so each leaves a working application: arrivals and a backlog first, then
jobs as the unit of work, then advisory blocking. This is the first.

### Demand is generated per week, keyed by week number

The plan called for pre-generating a fixed horizon at world creation. That was rejected once the live
lab was specified as open-ended: a horizon has an edge, and past the edge demand silently stops.

Each week's arrivals are instead derived from `deriveSeed(seed, 'demand:week:7')`, generated when the
clock first needs them. This keeps the property the horizon was there to provide — week 7 is week 7
whether it was generated up front or walked to over six simulated weeks — and removes the edge. A
batch run that jumps straight to week 7 and a live session that walks there see the same samples.

Generation is driven from the end of the span about to be simulated rather than per slice, which is
what makes it independent of step size: one fortnight-long call and twenty thousand one-minute calls
both finish having generated through the same week, because the last call ends at the same instant.

**Alternatives considered.**

- *Poisson arrivals.* More principled for independent events, and rejected because the scenario's
  numbers come from a lab manager describing a range — "about eighty blood panels, give or take
  twenty percent". A uniform band is what that sentence means. Recorded in `arrivals.ts` as a
  modelling choice rather than left to look like an oversight.
- *Arrivals spread across the whole week.* Rejected: samples are delivered by couriers and clients,
  so they arrive while the lab is open. Spreading them across *opening minutes* is also what makes
  "arrived Thursday 15:55" a case the model can produce, which is the awkward case for a deadline.
- *Deadlines as countdowns.* Rejected, and this is the same correction the calendar made: a countdown
  has to be decremented by someone, which is why lateness used to be binary and why a paused job kept
  losing time. A deadline is now an absolute instant computed once at arrival and never recomputed.

### Mass spectrometry is new work

Phase 1 recorded that bought equipment could never relieve a bottleneck, because steps matched
machines by exact name and no task named a machine the shop sold. The Mass Spectrometer existed,
could be bought twice, and could never affect anything. There is now work that asks for it. A test
asserts that, so the finding cannot quietly return.

### The calibration reproduces the specification's own figure

The step table was transcribed from `docs/product-spec.md`, which arrives at **186 hands-on hours per
week** independently, from the lab manager's stated volumes. Summing the step table gives 11,160
minutes — 186.0 hours. That agreement is the strongest available check that the numbers were
transcribed rather than invented, since a wrong duration anywhere breaks it, so it is now a test
rather than an observation. A7 does the full load audit; this is the headline.

Observed behaviour with nothing consuming the queue, which is what this commit produces: 30 waiting
after one day, 151 by Thursday close, and **flat across Friday and Saturday** — demand respects the
calendar, not only deadlines. Also now a test.

**Verification.** 25 new tests in four groups: fairness (demand unchanged by hiring, by leasing, and
by how long the lab has been running), shape (weekly volume, never outside the declared band, varies
week to week, business hours only), deadlines (close of business, skips the weekend, set from each
job's own arrival), and admission (arrives at the right instant, never inherits post from before the
run started, keeps generating indefinitely, unique ids in arrival order). The slicing fingerprint
gained jobs, the arrival queue and the week counter, so arrivals are covered by the step-size
invariance gate too.

### What the mutation testing found, including two tests that were weaker than they looked

Six deliberate breakages:

| Mutation | Tests failed |
|---|---|
| A. Week key ignores the week number | 2 — the eight-week mean, and week-to-week variation |
| B. Arrival seed renamed to the operations label | 0 — **not actually a defect**; see below |
| C. Arrivals spread over 24 hours instead of opening hours | 3 — closed days, opening hours, spread |
| D. Slice loop no longer clamps to arrivals | **0** |
| E. Week seed keyed on headcount | 1 — unchanged by hiring |
| F. Week seed keyed on machine count | 1 — unchanged by leasing |

Three findings worth recording.

**Mutation B was not a defect, and the first attempt at a real one still was not.** Renaming the
derived label changes which sequence is used but keeps it independent of the lab, so nothing should
have failed and nothing did. Making the week seed depend on `world.rngState` is a genuine regression —
demand would then move when the lab's own generator moved — and it was caught by only one test, which
exposed two separate weaknesses in the others:

- The fairness tests advanced a fortnight in a single call. Demand for a whole span is generated at
  the top of `advance`, so one long call generates every week *before the lab has done anything*, and
  a test written that way cannot see demand becoming dependent on the lab. They now walk a day at a
  time, which is also what the live view does.
- They used the default roster, which is six of eight, so an appended ninth hire was off duty and made
  no draws at all. **This is the second time that exact trap has appeared** — it was found in
  `fairness.test.ts` the day before — so the helper and the reason are now written out in both files.

Even corrected, the hiring test does not fail under that mutation, and the reason is the previous
step's fix working: staffing cannot reach the operations stream at all any more, so demand keyed on
`rngState` is still independent of headcount. Mutations E and F confirm the two fairness tests can
fail, keying demand directly on the counts they are supposed to be independent of.

**Mutation D failed nothing, and the code was kept anyway.** Clamping each slice to the next arrival
is not yet load-bearing: nothing acts on a job the instant it arrives, so admitting one at the end of
whatever slice it fell inside gives the same answer. It stops being true in the next commit, where a
free person can pick a job up the moment it lands — and then the difference between "started at 09:40"
and "started at midnight, because the batch runner steps a day at a time" is a working day of
throughput. The comment in `tick.ts` says this explicitly, so the line does not read as dead weight,
and the test that makes it load-bearing arrives with the behaviour that needs it.

**A performance regression caught by a timeout, not by a wrong answer.** `ensureArrivalsThrough`
sorted the arrival queue on every call. At a sixtieth-of-a-second step that is 864,000 calls for four
simulated hours, and the invariance test went from two seconds to over twenty-five and timed out. The
fix is an early return when there is nothing to generate. Worth noting as a shape: the slice loop runs
often enough that anything called per slice has to cost nothing in its common case, which is a
constraint the rest of this phase inherits.

### The view

One panel changed. "Task Definitions" listed the three recipes, which never changed and so told the
manager nothing; it is now "Work Queue" and shows what is piling up — how many of each kind wait, the
hands-on hours they represent, the soonest deadline, and how many are already overdue. Read entirely
through the query seam built in A0, so the panel does not know how a job is represented and will not
need touching when the next two commits change that.

---

## 21. A run has to be nameable before it can be verified

**Context.** Verifying A3a on a preview exposed a limitation that had been inherited from Phase 1
without being noticed: the simulated clock started from the real time of day. Three consequences, all
of which only become visible once there is something to verify that takes more than a minute of
simulated time to happen:

- **Two loads of the same seed were not comparable.** `?seed=42` fixed which lab, but not when the
  run opened, so the same seed produced a different sequence of events on every load. The one thing
  the seed existed to provide was undermined by the clock.
- **A demo opened in the evening showed an empty lab.** Everyone off shift, no arrivals, nothing
  happening — the worst possible first impression, decided by what time the page happened to be
  opened.
- **Anything later in the week was unreachable.** The weekend pause and the first overdue job are
  real behaviours with tests behind them, but confirming them on screen meant waiting days of real
  time. Three of the five checks requested for A3a could not be carried out.

**Decision.** Three options in the URL, parsed in the view layer only:

```
?seed=42&start=sun-08:00&speed=60
```

`start` takes a day name and a time (`thu-15:55`), or a bare time meaning Sunday. A day name rather
than a date, because the simulation's calendar is a repeating week with no notion of a month, so
"Thursday afternoon" is the most specific thing that can be meant. `speed` multiplies simulated time,
clamped to 0.1–1440; the upper bound is a simulated day per real second, past which a frame advances
more than the eye can follow.

**The default start is now Sunday 08:00 rather than the wall clock.** A run that is not told when to
open should open at the beginning of a working day, because that is the only choice that makes the
same seed mean the same run.

**Where this lives, and why it matters.** `src/ui/runOptions.ts` — the view layer. The engine takes
the start minute and the speed as plain arguments and may not read `window`, `Date` or the URL, which
lint enforces. Parsing is pure: it takes the query string and the current time as arguments rather
than reading either, so it is testable with no browser. That is the same discipline as the rest of
the engine boundary, applied to the one place where a URL is allowed to be read.

Bad values warn and fall back rather than guessing, and one bad value does not discard the others. A
demo that silently opened on the wrong day would be worse than one that says it could not read what
was asked for.

**The run identifies itself on screen.** A badge in the game header reads `seed 42 · sun-08:00 · ×60`.
Reading the console to find out which lab you are looking at is adequate for one person debugging and
useless for comparing two tabs side by side, which is exactly what Phase 4 asks a manager to do.

**Verification.** 17 tests on the parsing, including a round-trip through the label the badge shows,
and that `?seed=42&start=sun-08:00&speed=60` produces exactly `{ seed: 42, startMinutes: 480, speed: 60 }`.

Two engine tests on `speed`, which had none despite the field existing since Phase 1: sixty ticks at
×1 agree with one tick at ×60 — same clock, same jobs, same event schedule, to six decimal places —
and ×0 stops the clock. The agreement is not a coincidence to be grateful for; it is the slice loop
from A2 doing its job, because speed multiplies the `dt` handed to the engine rather than changing any
rule. Worth having as a test now that a URL can set it, since the ×1/×10/×60 controls Phase 4 needs
are the same mechanism.

### The deadline convention, confirmed and written down

Review asked whether deadlines are close of business on the n-th working day. They are, and the
observed numbers confirm it: a blood panel arriving Sunday 13:52 showed "due in 2d 2h", and
2 working days later at 16:00 is minute 3,840 against an arrival at minute 832 — 3,008 minutes, which
is 2 days and 2.1 hours. The cell culture's "9d 2h" is the same arithmetic over seven working days
with Friday and Saturday skipped.

Two separate choices are buried in that convention, and neither was written down anywhere. Both are
now question 9 in `docs/product-spec.md`:

- *Close of business rather than the same time of day.* A sample arriving at 15:55 gets effectively
  the same deadline as one arriving at 08:05. The alternative, 48 working hours from the moment of
  arrival, would give the late arrival five minutes more. Close of business is what a client means by
  "by Tuesday", and it makes the deadline one unambiguous instant rather than one that depends on
  when a courier turned up.
- *The arrival day does not count.* Already configurable as `calendar.deadlineCountsArrivalDay`, but
  the reasoning was only in a code comment.

Worth confirming with the lab manager, because it shifts every deadline by a day and so changes how
much work the simulation reports as late.

---

## 22. Jobs become the unit of work

**Context.** Entry 20 made work arrive and queue. It still could not be *done*: progress lived on the
person as `taskStep` and `taskTimer`, so a job could only advance while a particular person was
attached to it, and any interruption had to be unwound by hand.

**Decision.** The tick loop iterates jobs rather than people. A job holds its own progress as
`remaining` on its current step; `Staff.jobId` points at the job and `Job.operatorId` points back,
and both are written in one place so they cannot drift apart.

Holding `remaining` rather than elapsed-plus-total is the whole argument. Pausing is not
decrementing. A shift ending, a person going sick, a reassignment and later a breakdown need no code
of their own and nothing restored on resume, because nothing anywhere records when a step started and
so nothing can disagree about it.

`ASSIGN_TASK` is replaced by `ASSIGN_JOB`, and the recipe path is deleted: `TaskDefinition`,
`scenario.tasks`, `world.tasks` and the dialogue that listed three things the lab could do. The
dialogue now lists real samples that are waiting, soonest deadline first, with the price, the work
left, the next machine and — for work this person cannot start — the skill they are missing.

Deliberately not in this commit: lateness still pays full price (the partial-credit arithmetic
belongs with rush orders in A6), nothing chooses who works on what (the dispatcher is B3), and
`blocked` is never set (A3c). Emergencies keep their own code path, including the last uses of
`activeTask`, `taskStep` and `taskTimer`, until A6 deletes them.

### An aggregate-only bug: no unit test could have caught it

Everything passed. Then a throwaway script ran ten simulated days with every free person taking the
soonest job they could, and the backlog *grew* — 11 waiting on day one, 82 by day ten, against a lab
with 240 rostered hours a week offered 186 hours of work.

The cause was a choice made two hours earlier and documented as if it were obviously right:
qualification was judged over **every remaining step** of a job, so a job could only be taken by
someone able to finish the whole thing. An audit of what that implied:

| Work type | Offered | Needs one person with | Rostered who can |
|---|---|---|---|
| Blood panel | 60 h/wk | Centrifuge Usage + Microscopy | 1 — Hadas |
| DNA / PCR | 60 h/wk | PCR Operation + Spectrophotometry | **nobody** |
| Cell culture | 36 h/wk | Biosafety + Incubator + Microscopy | **nobody** |
| Mass spectrometry | 30 h/wk | Mass Spectrometry | 2 |

**96 of 186 offered hours a week were structurally impossible**, and the binding constraint was one
technician's skill set rather than the mass spectrometer the scenario is built around. A7's load audit
run against that model would have reported a bottleneck that was an artefact of a single `.every()`.

Real labs hand a sample from one specialist to the next between steps, which is what the plan's own
handover design assumes. So qualification is now per step: a person can take a job if they can do the
step it is on, and at a step boundary they keep it only if they can do the next one. Otherwise the job
goes back to the queue part-finished, prepped, for whoever can — reported as `job-handed-over`, which
is normal traffic rather than a failure, but worth reporting because a job waiting a long time for its
second specialist is a real cost with no other symptom.

Same ten days after the change: the queue clears rather than growing, 246 jobs done against 164, 192
handovers, nothing abandoned.

**This was an aggregate-only bug, and that is the part worth keeping.** No unit test could have
caught it, and no additional unit test would have. Every one of the twenty-three tests on the job
lifecycle passed, before the fix and after, because each one follows a single job through a single
sequence and the defect is only visible as a property of the whole lab over a week: *more work
arrives than leaves.* Each individual job behaved exactly as specified. The specification was wrong.

The class matters beyond this instance. Unit tests answer "does each part do what I said", and that
question is silent about "is what I said coherent as a system". The second question needed a
different instrument — thirty lines of throwaway script running ten simulated days and printing one
line per day — and it is now a standing part of how each step gets checked, not a one-off. A7's load
audit is the formal version of the same idea, computed in closed form rather than simulated.

Two further notes on how it was found. The test that *encoded* the wrong behaviour had been written
confidently, with a comment explaining why requiring the whole remaining job was correct — so the
tests did not merely fail to catch the error, they asserted it. And the regression test now in place
is deliberately the cheap version of the audit above rather than a re-run of the simulation: every
step of every work type must have a rostered person who can do it. If qualification ever reverts to
whole-job, three of the four work types fail immediately and by name.

### A scheduled instant missed by two ulps

The second real bug in this commit, found by a test that changed nothing but the slice pattern.

Silencing the old emergencies inside the job tests — they fire every half hour, go unassigned, and
charged a quarter of a million in penalties over the weeks these tests span, drowning out the figures
being measured — made three expiry tests fail. The job due to be abandoned at minute 11,040 was
reached at **11,039.999999999998**, so `simMinutes >= expiresAtMinute` was false and it was never
abandoned.

The slice loop clamps a slice to end exactly on a scheduled instant, but `simMinutes + slice` is not
bit-identical to that instant after thousands of additions. Worse, whether it lands short depends on
the history of slice lengths — so the same scheduled event fires in one run and is skipped in
another, which is precisely the step-size dependence the loop exists to remove, reappearing two ulps
below the threshold.

Every comparison of the clock against a scheduled instant now goes through one tolerant function,
`hasReached(now, instant)`: job expiry, the emergency schedule, idle wandering, and arrival
admission. The deadline comparison is tolerant the other way, so finishing *at* the deadline counts
as on time — the boundary belongs to the client.

A2 recorded two bugs of this shape and called them float dust. This is the third, and the lesson is
sharper than "add an epsilon": a loop that deliberately lands on instants needs **one** definition of
having reached one, used everywhere, for the same reason it needs one definition of having arrived
somewhere. Both now live in `geometry.ts` next to each other.

Confirmed load-bearing: restoring the exact comparison fails four tests, including one that runs the
same scenario with and without emergencies and requires the same outcome.

### A silent bug from the previous commit

The Work Queue cards pass a work-type id to `highlightQualifiedStaff`, which looked it up in the
now-deleted recipe list — so hovering the queue highlighted nobody. No error, no symptom beyond an
effect not happening. Replaced with `qualifiedStaffForWorkType` through the query seam, which matches
anyone who can do *any* step, since highlighting only those who could do a whole job would have
highlighted nobody for three of the four kinds of work.

Worth noting what kind of bug this is: the previous commit changed what a `data-` attribute carried
and the consumer silently accepted the new value. Neither the compiler nor the linter can see across
a DOM attribute, which is the same gap that produced the `setHtmlById` incident in Phase 1.

**Verification.** 23 tests on the job lifecycle, in five groups: taking a job on, interruption costing
nothing (counters unchanged, machine given back, someone else finishing with no work lost or
repeated), handover between specialists, finishing (paid, freed, reported, steps in order, late when
late), one machine one job, and abandonment. Plus the two regression tests above. The slicing
fingerprint gained job status, operator, machine, every step's `remaining` and settled revenue, so
all of it is inside the step-size invariance gate.

### Also

`fromBusinessProfile` had to invent a weekly volume, a variation and a deadline, because the
onboarding form asks for none of them. Flagged in the code and already on the Phase 2.5 list: either
the form asks, or that path stops presenting itself as a model of a real business.

A test helper now throws when handed an off-duty person, naming the reason. The scenario rosters six
of eight, and an off-duty person silently refuses every assignment — which had produced a
passing-for-the-wrong-reason test for the **third** time in three files.

---

## 23. The calendar finally drives the working day

**Context.** A1 built a working-time calendar — `isWithinShift`, `nextOpen`, `shiftEndAfter`,
`nextCalendarBoundary` — with 48 tests, and then **nothing called any of it** except for deadlines
and clock labels. People changed shift only when someone clicked a button.

That was invisible for two entries, because work could not outlive a few minutes. With jobs it means
a technician works through the night, the lab has no closing time, every figure about capacity is
wrong, and decision C of the four the product exists to evaluate — add an evening shift — is
unmodellable, because the day shift never gives the instruments back.

A1's own log entry promised the opposite: *"Work in progress at 16:00 pauses, the operator goes off
shift, and the resource is released."* It was written as a settled design decision and never
implemented. Worth recording as a kind of error in its own right: a tested module with no callers
reads as finished work, and the test suite is no help, because the tests pass.

**Decision.** One untangling and one hook.

**`rostered` is now separate from `state`.** `state === 'off'` had meant two unrelated things — "not
employed on this shift" and "outside opening hours" — so once the clock started sending people home
there was no way to tell someone who had gone home from someone who is not on the rota. `rostered` is
what a hire changes and what the shift button toggles; `state` is the clock's to write. The button is
relabelled "Put On Rota" / "Take Off Rota", because that is what it does.

**`applyShiftWindow` runs every slice**, bringing rostered people in at opening and sending them home
at close. Sending someone home releases their job and the machine it holds. The job goes back to the
queue part-finished with its counters untouched, which is the whole return on holding progress as
`remaining`: there is nothing to save, nothing to restore, and no overnight special case anywhere.

Releasing the *machine* is the part with consequences. Held overnight, utilisation would read 100%
with nobody in the building, and an evening shift would add no capacity at all.

Sickness and leave survive a shift change: being sick is about the person, not the hour, and letting
the clock clear it would mean an illness that ends at closing time. `SET_STATUS` and `TOGGLE_SHIFT`
now both defer to `applyShiftWindow` for where someone actually lands, rather than writing `state`
themselves — which is the Phase 1 "clearing sick put an off-duty person back on shift" regression
fixed at the root rather than patched again.

`createWorld` reads the calendar directly rather than calling `applyShiftWindow`, because that would
make `world.ts` depend on `shifts.ts` → `jobs.ts` → `world.ts`. The dependency direction is worth
more than the reuse; the duplication is one `isWithinShift` call.

### An ordering bug that lost work, caught by the step-size test

The first version ran `applyShiftWindow` with the other clock business, before anyone worked. It lost
the last slice before closing.

A slice clamped to end at 16:00 lies **entirely inside** working hours, so every minute of it counts.
Sending people home first meant the job was already back in the queue when `tickJobs` ran, so that
slice's work was discarded — and how much vanished depended on how long the slice happened to be. A
fine run and a coarse run disagreed: 14 minutes of work against 15.

The fix is to run it last, after the slice everyone was present for has been paid for. That is the
same rule A2 arrived at for emergencies and equipment wear — *whatever was true during a slice is
charged for that slice before anything changes* — which is now the third distinct bug caused by
getting it wrong. It is worth stating as a standing rule of this loop rather than rediscovering:

> Within a slice, charge first and change state afterwards. Anything that ends a slice has already
> been true for the whole of it.

The assertion that caught it is worth describing, because the obvious version did not work. Measuring
"she started at 15:40, so twenty minutes must be gone" failed on a rounding artefact of the test's own
setup loop. Comparing against **a second lab with the same seed whose shift never ends** is exact: up
to 16:00 the two are the same lab, so the work done must be identical, and from 16:00 they must
diverge. No tolerance, and it tests the thing directly.

**Verification.** 21 tests in four groups: who is in the building (empty floor at 02:00, sent home at
16:00 to the minute, back next morning, empty all weekend, events for both), closing time and work in
progress (set down part-finished, machine returned, no progress overnight, the carried-over job named,
picked up and finished next day, no assignment outside hours), the roster against the clock (off the
rota goes home now, onto the rota waits for morning, sickness survives a shift change, clearing
sickness at night does not put someone on the floor, someone off the rota is never brought in), and
step-size invariance across six step sizes from half a minute to a whole day.

Three mutations, all caught: running the shift window before jobs advance fails 2 (both invariance
assertions); ending a shift without releasing the job fails 6, including the slicing fingerprint; and
removing the loop's clamp to opening and closing fails the invariance test.

**Observed.** Twelve simulated days with every free person taking the most urgent job they can: six
people on the floor on working days, **nobody on Friday or Saturday**, and 44 jobs carried over a
night. The backlog grows from 7 to 81 over the fortnight — 186 hours of work offered against 240
rostered hours, with the shortfall going into walking between machines and into jobs waiting for
reassignment after a handover. Whether that gap is a genuine finding about the lab or an artefact of
assignment is exactly what A7's load audit is for, and it is not worth guessing at before then.

### A small fix from review

The Work Queue's hover highlight lit up everyone qualified, including people off sick or off the rota.
`qualifiedStaffForWorkType` now returns two lists and the panel marks them differently — solid for
those who could take the work now, dashed and faded for those who could not. "Three people can do this
and two of them are out" is a more useful sentence than "three people can do this", and it is the one
that makes a hire or a training worth considering.

---

## 24. A reported bug that was a lying label, and a measurement that refuted its own premise

Two items from review of entry 23, both instructive for the same reason: a number on screen was
trusted as evidence about the simulation, and in both cases the number was wrong rather than the
simulation.

### "Progress is not kept at end of shift"

Reported with a precise reproduction: seed 42, Thursday 14:00, ×5; a mass-spec job assigned, worked
for about fifteen simulated minutes, and after 16:00 showing in the queue as "1h left" with no
part-finished marker — while the sick-mid-job path demonstrably did keep progress.

Reproducing it exactly, down to the same job id, the engine turns out to be correct:

```
assigned : remaining = 60.0   status = in-progress
at 16:00 : remaining =  8.1   status = waiting
Mass Spectrometer totalWorkTime = 51.9
```

Fifty-two minutes of work done, 8.1 remaining, and the machine's own counter agrees. Nothing was
lost. The assign dialogue would have printed "8m left".

What *was* wrong is the marker the report relied on. `partlyDone` was `job.stepIndex > 0`, which
detects progress only across a step **boundary**. Mass spectrometry has a single step, so a job 86%
finished reported itself as untouched — and mass spectrometry is a quarter of what the lab sells. The
only signal available for "has anybody worked on this?" was wrong for all single-step work. It is now
`steps.some(step => step.remaining < step.total)`.

**The second-order lesson is the useful one.** The reported symptom ("1h left") could not be
reproduced and the reported diagnosis was wrong, but the report was still right that something was
broken, because the reporter was reasoning from the only evidence the interface offered and that
evidence was false. A misleading label does not merely fail to inform — it actively produces wrong
conclusions about working code, and costs more than a missing one.

### Why the walk looked ten times longer than it is

The same report noted roughly seven real seconds at ×5 between assigning a job and the badge reading
"working" — about thirty-five simulated minutes of walking.

The walk is actually about one and a half simulated minutes. The lag was the **staff panel**, which
was driven by the event stream alone. Arriving at a machine and starting work produces no event: it
is a consequence of the clock. So a badge could read "idle" for as long as it took the next unrelated
event to arrive and rebuild the panel — and at ×5 that is tens of simulated minutes of apparent lag,
at ×60 hundreds.

The staff panel now refreshes on the same 250 ms interval as the panels that already needed it. The
event-driven rebuild was introduced in Phase 1 to stop four panels being rebuilt 240 times a second;
the correct split is not events-against-frames but *changes caused by an event* against *changes
caused by the clock*, and a person's state moved into the second category the moment the engine
started changing it on its own.

### The walking measurement, and the theory it refuted

Review asked for average walking minutes per step over a simulated week, reported against the 186
hours offered and 240 hours rostered. The premise was reasonable and checked out arithmetically:
before A2 walking was 1.2 grid units per simulated *second* with the clock at 0.5 simulated minutes
per second, i.e. 2.4 grid units a simulated minute; after A2 it is 1.2 a minute. **The simulated cost
of walking did exactly double.**

The first measurement appeared to confirm the theory: 6.87 minutes a step, 24.7 hours a week, a 23.6%
overhead on hands-on time. That number was wrong. It counted *standing at a machine somebody else is
using* as walking, because the two are indistinguishable in the state — on a job, not working. They
mean opposite things: one is overhead, the other is a bottleneck.

Separated, over one simulated week with every free person taking the most urgent job they can:

| | h/week | per step |
|---|---|---|
| Hands-on work | 104.8 | |
| **Travelling** | **4.8** | **1.33 min** |
| **Waiting for a busy machine** | **19.9** | |
| On a break (energy) | 18.0 | |
| **On shift with nothing they can do** | **92.5** | |
| Total on-shift | 240.0 | |
| Work offered | 186.0 | |
| Jobs completed | 105 of ~162 arriving | |

Walking costs 2% of rostered time. It is not what stops the lab keeping up. What does:

- **92.5 hours a week of people on shift with no job they can start.** Forty of those are the junior
  researcher, who holds no skills at all, so his rostered time can never be used by anyone. Another
  26.7 are the manager, whose three skills match only two steps across the whole catalogue. This is a
  **finding about the lab, not a defect** — "somebody is idle all week because they are not trained on
  anything" is precisely the sentence this product exists to produce — so the scenario is left
  untouched.
- **19.9 hours a week waiting for a machine somebody else is using.** Genuine contention, and the
  first measurement in this project that points at the kind of bottleneck the scenario is built
  around. A5's instrument counts and A7's audit are what explain it.
- **18 hours on a break**, driven by the invented energy percentage, which B1 deletes.

**Walking is left as it is for now, and the reason is worth stating.** It is physically indefensible
— 1.2 grid units a minute is about 1.2 metres a minute if a grid unit is roughly a metre, against a
human pace of eighty — but correcting it recovers 2% of capacity and would make the sprites cross the
lab in a fraction of a second at ×1, since one real second is one simulated minute. The tension is
between a model that is right and a picture that is legible, and it belongs to Phase 2.5, which owns
the visual redesign and the speed controls. Added to that list rather than decided here.

### The measurement is now a test

`capacity.test.ts`, in two parts. A conservation law — every person-minute is accounted for as exactly
one of working, travelling, waiting, on a break, free or off shift, to four decimal places — because
minutes that go missing or get counted twice would corrupt every capacity figure downstream and
nothing else would notice; all three A2 ordering bugs were of that shape. And the measurement itself,
with bounds, so the figures above cannot drift unnoticed.

It uses a deliberately naive assignment rule rather than waiting for B3's dispatcher, because the
point is to measure what the *model* costs and a clever assignment would hide it.

This is the second time in two entries that the aggregate view has found something no unit test
could. It is now a standing part of checking a step rather than something reached for after a
surprise.

---

## 25. The scenario had drifted from the specification

**Context.** Review checked the scenario's staff against `docs/product-spec.md` §3.2, which is the
source of truth, and found that **seven of the eight people differed**. The previous entry had
reported 92.5 hours a week of people on shift with nothing they could do, and concluded it was a
finding about the lab. It was mostly a data mismatch.

| Person | Spec §3.2 | Scenario | Difference |
|---|---|---|---|
| Amit Katz | Microscopy, PCR, Mass Spec, Biosafety | same | role wording only |
| Michal Levi | Spectrophotometry, Incubator, **Biosafety** | **Management**, Spectrophotometry, Incubator | Biosafety missing; "Management" matches no step |
| Dana Cohen | Centrifuge, **Microscopy** | Centrifuge | Microscopy missing |
| Hadas Ben Hamo | Centrifuge, Microscopy, **Spectrophotometry** | Centrifuge, Microscopy | Spectrophotometry missing |
| Lihi Dayan | Mass Spec, Spectrophotometry, **PCR** | Mass Spec, Spectrophotometry | PCR missing |
| Amir Barzilay | **Centrifuge** | **none** | all of it |
| Nina Zur | **Part-time 20 h** · Biosafety, Microscopy, **Incubator** | Biosafety, Microscopy · **not employed** | Incubator missing; not employed |
| Alex Tom | **Part-time 20 h** · **Spectrophotometry** | **none** · **not employed** | all of it |

Every difference ran the same way: less capability than the spec grants. And `staffOnShiftCount`
stood at six, which excluded precisely the two part-timers — so a fifth of the lab's contracted hours
did not exist at all.

The drift is inherited. These skills are Phase 1 data, written before the specification existed, and
nothing had ever compared the two. "Management", which Michal held, is a capability no step requires
and could never have matched anything.

**Decision.** Transcribe §3.2 exactly. Contracted hours become real: `StaffTemplate.weeklyHours`, 40
or 20, and `Staff.shift` derived from it — so a part-timer on twenty hours works 08:00 to 12:00 and
goes home while the lab stays open until four. That required shifts to move **from the lab to the
person**, which is a change worth having anyway: decision C, add an evening shift, is a change to some
people's hours rather than to when the building is unlocked, and a single lab-wide shift could not
express it.

The morning reading of "part-time (20 h)" is a modelling choice rather than something the spec states;
it is one function, `shiftForWeeklyHours`, and a different reading is a data change.

### What it changed, measured the same way as before

One simulated week, same seed, same naive assignment rule — every free person takes the most urgent
job they can.

| | Drifted roster | Spec roster |
|---|---|---|
| Contracted hours | 240 | **280** |
| Hands-on work | 104.8 h | **126.2 h** |
| Travelling | 4.8 h (1.33 min/step) | 10.1 h (2.41 min/step) |
| **Waiting for a busy machine** | 19.9 h | **58.5 h** |
| On a break | 18.0 h | 22.7 h |
| **On shift, nothing they can do** | **92.5 h** | **62.4 h** |
| Jobs completed | 105 | 105 |

**Answering the question directly: it was mostly a data mismatch.** Idle time fell by 30 hours, and —
more to the point — the shape of it changed completely. It was one person with no skills absorbing 40
hours; it is now spread across all eight, the largest being 17.6 of Alex's 20 contracted hours. That
is a part-timer with one skill having gaps, not a lab that cannot use its people.

**The constraint moved from people to instruments**, which is what the specification intends.
Machine waiting tripled, from 19.9 to 58.5 hours a week. With proper skill coverage people can
actually take work, and what they then queue for is equipment.

### But the wrong instrument binds

```
Microscope A         31.7 h waiting
Centrifuge           13.2 h
Mass Spectrometer     4.4 h
PCR Machine           4.2 h
```

The microscope binds, not the mass spectrometer the scenario is built around. This is precisely the
risk the plan recorded against the step table: *"a different split makes the microscope bind before
the mass spec and the spec's whole story collapses."*

It is expected at this stage rather than alarming, because the thing that makes mass spectrometry
heavy does not exist yet. The spec's bottleneck claim is 30 jobs × 90 minutes of **instrument** time
= 45 hours a week, and instrument time separate from operator time is A4. Today a mass-spec job holds
its instrument for the 60 attended minutes only. Microscopy meanwhile is 80 blood panels × 20 min
plus 12 cell cultures × 45 min = 35.7 hours against roughly 40 hours of availability — 89%
utilisation, which queues.

Recorded now, before A4 changes it, so that the comparison can be made afterwards rather than
asserted. A7's load audit is the step that settles which instrument binds, and it is a fatal-error
check rather than an observation.

**Verification.** 214 tests. Fourteen needed updating, and what they needed is itself a record of how
much had been resting on the drifted data:

- Four tests used **Amir as the unqualified person**. He now holds Centrifuge Usage, so Alex Tom —
  Spectrophotometry alone — is the genuinely unqualified one for a blood panel.
- Three used **Dana as the person who can start a blood panel but not finish it**. She now holds
  Microscopy, so that role passes to Amir.
- Two trained **Dana on Microscopy**, which she now already holds, so the command was refused as
  already-known and the tests asserted nothing. Retargeted at Amir, who is also the person a training
  decision would realistically be about.
- Three assumed **somebody was off shift at 08:00**. All eight are employed now, so being off duty
  has to be arranged rather than found.
- One compared against a world whose **shift never ends** by overriding `world.calendar`, which stopped
  working when shifts moved onto the person — it would have passed vacuously.
- `capacity.test.ts` asserted **240 rostered hours** as head-count times forty. It now sums contracted
  hours per person, which is 280 and is the figure that was wrong before.

Two tests added: a part-timer goes home at noon while the full-timers work on, and a part-timer is
excluded from the free list once their shorter shift ends.

---

## 26. Naming what is holding the lab back

**Context.** The previous entries could measure that work was waiting; they could not say what for. The
week's measurement showed roughly sixty hours of people standing at instruments somebody else was
using, and that figure was only visible by instrumenting a throwaway script.

**Decision.** Every waiting job carries a `blockReason`, recomputed from scratch and never stored as a
decision. Five reasons, ordered by how *actionable* they are rather than how likely: a skill nobody in
the building holds, equipment the lab does not own, the lab being shut, the instrument being in use,
and everyone being busy.

The distinction that matters is the last two. Both look like "the job is not moving", one is answered
by leasing an instrument and the other by hiring, and they are two of the four decisions the product
exists to compare. Reported as one number they would be useless.

**`blocked` is advisory and never absorbing.** A blocked job is still `waiting` to every other rule:
assignable, expirable, countable. Treating it as a state a job moves *into* is the likeliest way to
ship a simulation that deadlocks by quietly doing nothing — which is the worst failure shape
available, because it looks like a working run with a disappointing result. Four tests exist only to
catch that: a blocked job can still be assigned with no unblocking step anywhere, the reason clears
the instant the obstacle goes, a blocked job can still be abandoned by its client, and a finished job
never carries a reason.

**A stall reports itself once.** `blockedSinceMinute` measures one continuous wait, and a *change* of
reason restarts it, because waiting for an instrument and then waiting for a person are two separate
waits and reporting them as one would name the wrong cause. Past `tuning.stalledAfterHours` (48) a
`job-stalled` event fires once. It changes nothing; it exists so a run that fails by doing nothing
says so.

Phrasing lives in `queries.ts`, not the engine and not the panel — the engine reports a reason and the
words are a display decision, but putting them in the panel would let the batch runner's verdict and
the live lab describe the same state differently.

Observed, with the naive assignment rule:

```
Sun 11:00 — 4 waiting for an instrument in use
Mon 11:00 — 5 waiting for an instrument in use · 3 waiting for someone to be free
Sat 11:00 — 39 waiting for the lab to open
```

A note on that observation: the first attempt at it reported "9 waiting for the lab to open" at what
the script labelled 11:00 on a working day, which looked like a clear defect. The script was wrong —
its loop counter started at the opening minute, so the label said 11:00 and the clock said 19:01, and
the engine had been right. Second time in three entries that a measurement harness, rather than the
thing measured, produced the alarming number.

### Two ordering problems, both already-known shapes

**Derived state belongs after every change, not among them.** Computed before the shift window, the
reason read "everyone is busy" at eight in the morning — true of the state at that instant, because
nobody had been brought in yet, and useless as a description. Moved to the end of the slice. The
general rule now has two halves: *charge for the slice before changing state, and derive from state
only once it has settled.*

**Anything per slice must cost nothing.** Recomputing every open job against every person on every
slice took the step-size invariance test from two seconds to over twelve. Throttled to once a
simulated minute, with the cost stated: a reason, and therefore a stall report, can be up to a minute
behind. Acceptable precisely because nothing decides anything from it. Separately, `nextShiftEventIn`
was walking the calendar day by day per person per slice — `nextOpen` contains a loop — and now caches
the next boundary until the clock reaches it.

That is the third performance regression in this phase from the same cause, after the arrival queue's
sort. The invariance test is doing double duty as a performance guard, because it is the only test
that runs the engine at its finest step size; it now has an explicit thirty-second budget rather than
being quietly shortened, since a sixtieth of a second is the live view's real frame interval and
shortening the span would lose the finest step the engine is ever asked for.

**Verification.** 15 new tests, 229 in total. Reason correctness for each of the five, the four
non-absorbing properties, stall reporting once rather than per pass, an ordinary overnight pause not
counting as a stall, and three no-stall properties over five simulated weeks: nothing waits past the
abandonment rule, no job is left in progress without an operator, and no machine is claimed by a job
that is not running.

---

## 27. Instrument time, operator time, and capacity as a count

Two planned steps in one commit, because instrument time only means anything once instruments have
counts.

**A step now asks for a capability, not a machine by name.** This retires the most consequential
limitation carried out of Phase 1: matching by name made capacity a *name* rather than a count, so the
shop sold "Microscope B" that no step asked for and buying a second instrument could never relieve
anything. A step asks for `microscopy`; any instrument offering it will do. The catalogue now sells a
second of something the lab actually uses, and a purchase is numbered after the instruments already
there rather than duplicating a name.

Three ideas that are easy to conflate and are now distinct:

- **Capability** — what an instrument can do, and what a step asks for.
- **Count** — how many the lab owns. *This is the decision.*
- **Capacity** — how many jobs one instrument holds at once. *This is physics.* Without it the model
  **jams** rather than queueing: twelve cell cultures at 48 hours each is 576 instrument-hours a week
  against 168 calendar hours, which no count can satisfy if each instrument takes one job. An
  incubator holds eight; a PCR block holds two; a centrifuge holds one.

**A step has an attended phase and an unattended one.** Mass spectrometry is 60 minutes of preparation
and then 90 minutes of the instrument running alone, and `resourceHeldDuring` says which phases hold
the instrument. Mass-spec preparation holds nothing, which is what makes the specification's own
arithmetic possible: 30 jobs x 90 min is 45 instrument-hours a week, where holding it during
preparation too would be 75 and the lab would be structurally broken rather than tight.

At the handover the operator is **released in the same slice** and is immediately dispatchable. That
is the whole point: an instrument can be the lab's constraint without its scientist being one.

**Unattended time ignores the calendar**, and needs no code to do so — only the absence of a shift
check. A 48-hour incubation started on Thursday afternoon finishes on Saturday with nobody in the
building. `tickUnattended` runs before everything else in a slice and is not conditioned on anybody
being present.

### The bug this introduced, and why it was invisible

After the change, throughput fell to **zero over four simulated days** while the backlog filled.

`tickUnattended` advanced `stepIndex` past the end of a job's step list and set the job back to
`waiting` instead of settling it. The last step of a job can be completed by an *instrument*, with
nobody attached — and mass spectrometry is a single step whose final phase is unattended, so every one
of the thirty a week reached the end of its work and was never finished.

What made it bad was not the leak but the camouflage. A job with no current step:

- had **no block reason**, because the reason computation skips a job with no step — so nothing
  reported it;
- reported itself **qualified for everybody**, because a missing step requires no skill;
- **sorted to the front** of the queue, having the oldest deadline;
- and then had every assignment attempt **refused**, because `canOperate` correctly says nobody can do
  a step that does not exist.

So the queue filled with work that could not be done, could not be finished, and could not be seen,
and it crowded out everything that could. Every individual rule was behaving exactly as specified.

Two fixes, deliberately both: `settle` now takes an optional operator so an instrument can finish a
job, and `listAssignableJobs` refuses to offer a job with no current step. Either alone would have hidden
the other.

**This is the third aggregate-only defect in this phase**, and the second found by a throwaway script
rather than a test. All 229 tests passed throughout. The pattern is consistent enough to state: these
bugs live in the *interaction* between a lifecycle and a queue, they present as a trend rather than a
wrong value, and nothing that examines one job can see them.

### What the lab looks like now

Four simulated weeks, naive assignment, against 186 hours of work offered and 280 contracted:

```
completed 119/wk of ~162 arriving, 0 expired, backlog 164
hands-on  137.0 h/wk
```

Instrument busy time, with the denominator that matters:

| Instrument | Busy | vs ~40 h attended availability |
|---|---|---|
| Centrifuge | 37.9 h/wk | **95%** |
| Microscope | 34.4 h/wk | **86%** |
| Biosafety Cabinet | 22.3 h/wk | 56% |
| Spectrophotometer | 20.4 h/wk | 51% |
| Mass Spectrometer | 24.3 h/wk | 14% of 168 h |
| PCR Machine | 40.2 h/wk | 12% of 336 slot-h |
| Incubator | 143.6 h/wk | 11% of 1344 slot-h |

**The centrifuge and the microscope bind. The mass spectrometer does not.** And the reason is worth
stating precisely, because it is a disagreement with the specification rather than an error in
transcribing it.

The spec's bottleneck claim is 30 jobs x 90 minutes = 45 instrument-hours a week. Whether that binds
depends entirely on the denominator. Against a 40-hour working week it is 112% and the instrument is
the lab's hard limit. Against 168 calendar hours — which is what the model now gives it, because an
unattended run continues overnight — it is 27% and the instrument is barely warm.

Blood panels, meanwhile, are 80 a week and both their steps are attended-only, so they compete for a
single centrifuge and a single microscope inside the working week: 80 x 25 min is 33 hours against
roughly 40 available.

So there is a real modelling question, and it is not one to settle unilaterally: **does a mass-spec run
left in the instrument overnight keep the instrument occupied until somebody unloads it?** If it does,
availability is the working week and the spec is right. If it does not, the spec's bottleneck is not a
bottleneck, which is a finding worth more than the assumption. Recorded in `docs/product-spec.md` as an
open question, and A7's audit reports utilisation against both denominators rather than picking one.

**Verification.** 13 new tests, 242 in total: the scientist released at handover, the instrument not
held during preparation, a second job preparing while the first instrument runs, an incubation
finishing over a weekend with an empty building, attended work not advancing out of hours, the
instrument freed when the run ends rather than when someone returns, a count expanding into separate
instruments with separate wear, one instrument serialising two jobs where two overlap them, shelves
letting several jobs share one instrument, the catalogue selling capability the work asks for, a bought
instrument numbered after the existing ones, and no instrument ever holding a job that has finished.

---

## 28. Rush orders replace emergencies

**Context.** Emergencies were a second kind of work with their own templates, their own entity, their
own progress fields on a person (`activeTask`, `taskStep`, `taskTimer`), their own three events, their
own modal, and a flat `penalty`. None of it was necessary. What makes an urgent job matter is
arithmetic, not mechanism.

The flat penalty was also actively wrong. It charged ₪4,000 for an emergency nobody had been assigned
to — work that, at any speed above ×1, no human could have reached — which is how a simulated
fortnight reached **minus a quarter of a million shekels**. Review hit exactly that while verifying
A3b.

**Decision.** `Job.rush: boolean`. A tenth of arrivals, 24 **wall-clock** hours rather than working
days, quoted at 1.5×. Settlement is four cases and no invented number:

| | on time | late |
|---|---|---|
| ordinary | price | 80% |
| rush | 150% | 70% |

A ₪900 job quoted as a rush is worth ₪1,350 landed and ₪630 missed — a swing of ₪720 against roughly
₪225 of materials already spent. The same job taken normally swings by ₪180, four times less. That
ratio is why a manager cares which rush orders she accepts, and it comes out of the prices.

A missed rush pays **less than an ordinary late job**, not merely less than its own quote. The client
was promised something and planned around it. Without that a rush order would be a free option.

A rush deadline is quoted in wall-clock hours on purpose, so one arriving on a Thursday afternoon may
be impossible before anybody touches it. That is a finding worth showing rather than a case to design
away, and it is configurable as `calendar.rushDeadlineMode`.

### The teardown

170 references across 11 files. Deleted: `EmergencyStatus`, `EmergencyTemplate`, `Emergency`,
`ActiveEmergency`, `scenario.emergencies`, `world.emergencies`, `world.emergencyTemplates`,
`world.nextEmergencyAtMinute`, `tuning.emergencyRatePerMinute`, `Staff.taskStep`, `ASSIGN_EMERGENCY`,
`assignEmergency`, `raiseEmergency`, `tickEmergencies`, the person-based `tickJob`, `isTraining`, six
events (`task-assigned`, `task-completed`, `task-failed`, `emergency-raised`, `emergency-expired`,
`emergency-resolved`), five view methods, the emergency modal, and `isQualified`'s last caller.

`failTask` survives for trainings alone, and with one kind of work to undo there is nothing left in it
to get wrong — it was the source of the Phase 1 crash where cancelling a training produced a `NaN`
budget.

`Staff.activeTask` is now `ActiveTraining | null`, and training is the only thing still held on a
person rather than on the work. That is right: training changes what somebody can do and belongs to
nobody else, so it has no job and no queue.

The lab-wide operations stream is gone too — the emergency schedule was its only consumer. Everything
random now comes from a named derived stream: demand per week, per person, per instrument.

**The panel did not need rewriting, only repointing.** It has always asked `listUrgentWork()` rather
than reaching into the simulation, so swapping the source from a separate entity to ordinary jobs
carrying a flag left the shape it receives unchanged. That seam was built in A0 as a sixty-line step
that changed no behaviour; this is the second time it has absorbed a model change for free.

Currency switched to ₪ at the remaining seven sites.

### What the teardown cost in tests, and what that says

Fourteen tests needed changing, and the pattern is worth recording: **eleven of them had been
silencing emergencies** — setting the rate to zero and the next one to infinity — because the old ones
fired every half hour, went unassigned, and buried whatever was being measured under a quarter of a
million shekels of penalties. That workaround had spread through five test files before anybody
questioned the thing it was working around.

One of them was load-bearing in an awkward way. The float-dust regression test from A3b-1 found its
bug *because* silencing emergencies changed the slice pattern; with emergencies gone that lever is
gone too, so the test now varies the step size directly instead — 1, 37 and 1,440 minutes to the same
instant. Same property, no dependence on a feature that no longer exists.

Two tests also had to stop using `nextEmergencyAtMinute` as the fairness fingerprint; they compare
arrival instants now, which is a better fingerprint anyway, because arrivals are precisely what a
comparison between two options must hold fixed.

**One test asserted the old behaviour and had to be corrected rather than fixed.** It checked that a
late job still paid full price, with a comment saying partial credit was coming in A6. It is now
`basePrice × 0.8`, and the arithmetic lives in `settlement.test.ts` where it belongs.

**Verification.** 12 new tests on settlement — the four cases, the specification's ₪630 example, a
missed rush being worse than ordinary lateness, the 4:1 swing ratio, the premium paid in a running
lab, nothing charged for work nobody reached, no finished job left unpriced, and three asserting that
rush orders are ordinary jobs with no separate entity, queue or person-held state. 256 tests in total.

---

## 29. The load audit, and the first answer

**Context.** Three defects in this phase have been visible only as a property of the whole lab over a
week, and all three were found by a throwaway script rather than a test. The audit is the formal
version of that script: load computed in closed form from the scenario alone, with no simulation, no
randomness and no clock.

It does two jobs. It refuses a scenario that cannot work before fifty runs are spent on it. And it
gives an independent check on the engine — the arithmetic and the simulation should agree, and where
they do not, one of them is wrong in a way neither could reveal alone.

### Utilisation is reported against two denominators, on purpose

This is the only honest way to handle the question the specification leaves open. An instrument doing
attended work can only be used while somebody is in the building, about 40 hours a week. One running
unattended continues through the night, so its availability is 168. Picking one denominator would
settle by assumption the thing that most needs asking.

```
capability          inst-h/wk  slots   of working wk   of calendar wk
  incubator            579.0      8           181%             43%
  pcr                  110.0      2           138%             33%
  mass-spec             45.0      1           113%             27%
  microscopy            35.7      1            89%             21%
  centrifuge            33.3      1            83%             20%
  spectrophotometry     30.0      1            75%             18%
  biosafety             24.0      1            60%             14%

binding skill: PCR Operation at 38%
```

**No fatal errors.** Three capabilities read above 100% of the working week and all three are feasible
*because* most of their time is unattended — which is exactly the distinction A4 introduced, now
independently confirmed. Had `resourceHeldDuring` been wrong, the incubator at 181% would have been
reported as impossible.

**Among the instruments somebody has to stand next to, microscopy binds at 89%** — 80 blood panels at
20 minutes plus 12 cell cultures at 45, against roughly 40 available hours. The simulation measured
86% independently. That agreement between closed-form arithmetic and a run is the check this step
exists for.

**Skills top out at 38%.** People are no longer the constraint, which confirms the roster alignment
was the fix and not a coincidence.

The audit also warns rather than failing on things that are merely odd: the Flow Cytometer and the
freezer are never used by any work type. They are on the floor of the real lab and the renderer draws
them, so reporting beats treating silence as approval.

### `npm run compare` — the first question answered

Fifty runs, four simulated weeks, two cases, **the same fifty demand seeds for both**. Entirely
headless, which is the return on the Phase 1 lint rule forbidding `window`, `Date` and `Math.random`
under `src/engine`: the batch runner exists because that rule was enforced rather than remembered.
Built for Node with a second small Vite config, so no new dependency was needed.

```
                            as is                 cross-trained x2      change
  jobs completed            475  (462–489)        441  (429–451)        -34
  jobs late                 96  (79–140)          194  (143–219)        +98
  rush orders missed        18  (13–23)           25  (18–30)           +7
  jobs abandoned            7  (0–28)             0  (0–3)              -7
  average backlog           97.4  (81.1–112.3)    112.3  (94.5–129.6)   +14.9
  mass-spec utilisation %   15.1  (13.3–16.4)     17.0  (15.3–18.2)     +2.0
```

**Cross-training two technicians on mass spectrometry makes the lab worse**, and the reason is printed
above the table rather than left to be inferred: microscopy binds, mass spectrometry does not. Dana
and Hadas are two of the three people who can use a microscope. Giving them a fourth skill means the
naive assignment rule sends them to mass-spec work, which was not the constraint, and the microscope
queue grows.

Two things about that result are worth separating.

**It is a real effect and a genuinely useful kind of answer.** "Training the wrong people makes a tight
lab worse by diverting scarce capacity" is counter-intuitive, actionable, and precisely the sort of
thing a manager cannot work out by looking at a spreadsheet. The one metric that moved the right way —
abandoned jobs, 7 down to 0 — is consistent with it: more hands on mass spec means fewer mass-spec jobs
sitting until a client cancels, bought at the cost of everything else.

**It is also partly an artefact of the assignment rule, and that must not be glossed.** The rule here
is "take the most urgent job you are qualified for", so a new skill can only ever *divert* somebody.
B3's dispatcher specifies a *least-versatile-first* operator policy for exactly this reason — don't
burn the only mass-spec scientist on a centrifuge — and under that policy the result could plausibly
reverse. The comparison must be re-run then, and the number above should not be quoted as a finding
about the lab until it has been.

### The batch runner cannot step coarsely yet, and why that matters

The plan assumed the batch runner would step an hour or a day at a time, with A2's slicing invariance
guaranteeing the same answer. The first version did, and the invariance test on it **failed**: the same
seed completed 97 jobs at a 15-minute step and 102 at a 1-minute step.

The engine is not at fault. Assignment happens *between* `advance` calls, from the runner, so a coarse
step also hands work out less often — people stood idle for up to a quarter of an hour beside work they
could have started. A2's guarantee covers events inside the engine; a command issued from outside it
is not one of those.

So the runner fixes its cadence at one simulated minute and offers no step-size option. It is
currently as slow per simulated minute as the live view, which is the price of the comparison meaning
anything, and the test that would have asserted invariance is replaced by one that records the
measurement and names what will fix it.

This is a constraint on B3 rather than a defect here: **the dispatcher has to live inside the slice
loop**, running at event boundaries like everything else, or no batch run is step-size independent. The
plan had the dispatcher as a policy question; it is also a placement question, and the placement is the
part that matters for trustworthiness.

**Verification.** 13 audit tests — the shipped scenario is possible, the 186/280 figures, people are
not the constraint, microscopy binds among attended-only capabilities, the mass-spec figure is 112% of
a working week and 27% of a calendar week, unused instruments are warned about, and five kinds of
impossible scenario are refused (missing instrument, missing skill, more hands-on work than contracted
hours, an instrument that could not keep up running continuously, and tight-versus-impossible kept
distinct). Plus two agreement tests: no instrument is used for longer than the work demands, and
hands-on minutes spent equal hands-on minutes the work called for, bounded by the sampling
granularity rather than by a tolerance picked to pass.

10 batch-runner tests, mostly about fairness rather than arithmetic: reproducible from a seed, both
options given the identical seed list, one assignment rule for every option, percentiles by nearest
rank so every reported figure is one that actually happened, the median unmoved by a single
catastrophic run, and an impossible scenario refused before fifty runs are spent on it.

279 tests in total.

---

## 30. Two occupancy assumptions, parameterised and recorded

**Context.** A7 ended with an open question it could not answer: whether a finished unattended run
frees its instrument immediately, or whether the sample sits in it until somebody comes to take it
out. The answer decides the denominator for every instrument's utilisation, and therefore which
instrument limits the lab.

**Decision.** Both the occupancy reading and the incubator's concurrent capacity become `Tuning`
values, which is where every model assumption belongs: `instrumentFreedWhenRunEnds: true` and
`incubatorCapacity: 6`. The incubator's equipment entry now reads its capacity from tuning, because
the number is a modelling assumption rather than a fact about the lab's furniture.

**The flag decides what the audit judges feasible**, not merely what it reports. With it true,
availability is the calendar week; with it false, the working week. That makes the assumption
consequential rather than decorative:

| Capability | Needs | In working hours | Verdict if strict |
|---|---|---|---|
| incubator | 579.0 h/wk | 240.0 | impossible |
| pcr | 110.0 h/wk | 80.0 | impossible |
| mass-spec | 45.0 h/wk | 40.0 | impossible |

Under the permissive reading the scenario has no infeasible capability at all. Under the strict one it
has three. The same lab, the same numbers, one assumption.

**The simulation implements only the permissive reading, so the engine refuses the other.** Modelling
the strict one needs an unload step the engine does not have, and a flag that silently governs the
audit but not the run would be worse than no flag: it would produce a confident answer to a question
it had not actually asked. `createWorld` therefore throws on `instrumentFreedWhenRunEnds: false`,
naming the spec section. This is the same lesson as A1's untested-calendar — a half-wired parameter
reads as finished work — applied before it could cause anything.

**Incubator capacity at 6 rather than 8.** Reported load rises from 43% to 57% of a calendar week, and
from 181% to 241% of a working one. Still comfortable under the permissive reading. PCR is unchanged
at 110 instrument-hours a week: 138% of working hours, 33% of the calendar.

Both are written up as numbered assumptions 10 and 11 in `docs/product-spec.md`, each with why it was
chosen, what it changes, and a specific question to put to the lab manager — for occupancy, what
happens to a run finishing at 16:30; for the incubator, how many cultures are genuinely in it at once
on a normal week.

**Verification.** Four tests: the permissive reading is feasible, the strict reading produces exactly
three errors naming all three capabilities, `createWorld` refuses the unimplemented reading, and
capacity 1 makes cell culture impossible while the shipped value does not. 283 tests in total.

---

## 31. Hours, overtime and fatigue; energy deleted

**Context.** `energy` was a percentage that drained while working, refilled while resting, sent people
on breaks at 20% and released them at 95%. It was grounded in nothing measurable, it gated nothing a
decision could turn on, and it was carried through all of Phase 1 as a known limitation precisely
because removing it before a replacement existed would have changed the interface for no gain.

**Decision.** Three numbers per person, all measurable: `minutesWorkedToday`,
`minutesWorkedThisWeek`, `overtimeMinutesThisWeek`. Reset by day and week hooks that compare the clock
rather than being scheduled — midnight falls outside every shift, so no attended minute is ever
credited between a day ending and the reset noticing.

**Fatigue is a pace, read at one call site.** Past `fatigueAfterWeeklyHours` (45), attended work is
consumed at 1/1.1 of the rate, so the same minute of presence buys less work done. No flag, no "tired"
state, no recomputation when the threshold is crossed mid-step. That matters because the stored-flag
version is exactly the failure mode `energy` had: two places describing the same person and able to
disagree.

**Overtime is judged against each person's own contract**, not against forty hours. An hour of Nina's
Tuesday afternoon is overtime because her shift ends at noon; a weekly threshold would have called it
ordinary and made a part-timer's overtime free.

### Overtime could not happen, which made the specification unmodellable

The specification prices overtime in bands — the first two hours a day at 125%, beyond that 150%, cap
twelve hours. None of it could ever apply, because `applyShiftWindow` sent everybody home the instant
their shift ended. The bands would have priced a quantity that was always zero, and the lab manager's
actual complaint — *overtime is invisible until payroll* — would have been impossible to show.

So people may now stay late, under the narrowest rule that produces overtime at all: **finish the step
you are on, then go.** Nobody starts new work after hours and nobody exceeds the daily cap. It needs
no policy input and no judgement about when a lab would ask somebody to stay, which matters because a
richer rule would be a modelling opinion rather than a mechanism.

This is a deliberate behaviour change and it broke nine tests, all of which asserted the old promise
that a job is dropped mid-step at 16:00. They now assert the new one, which is more specific: a job is
set down at close only when its operator stops *mid-step*, and the only things that do that are the
daily cap and sickness. The step-size invariance test survived the change with its invariance intact
and only its magnitude bound removed — which is the right outcome for a test of a property rather than
of a number.

### Three bugs, two of them boundary conditions

**Overtime was judged by where the clock is, not where the slice was.** The clock advances before work
is credited, so a slice ending exactly at 16:00 was recorded as overtime — a quarter of an hour of
ordinary afternoon charged at a premium. Credit is now judged at the slice's *start*, which is
unambiguous because the loop clamps to shift boundaries and a slice never straddles one. Same shape as
the A3b-2 ordering bug and the third boundary error of this kind in the phase.

**The shift window undid the daily cap.** Hitting twelve hours sent somebody home mid-step; the window
then ran, saw an open lab and an off-duty rostered person, and brought them straight back. The cap now
holds somebody at home for the rest of the day. A guard that fires and is immediately reversed is
worse than no guard, because the ledger shows the cap working.

**A test's "next morning" was the next closing time.** Advancing a flat day from 18:00 lands at 16:00,
when the person is going home again — so the job was never picked up and the test failed for a reason
unrelated to what it was testing.

### The view

The energy bar becomes an hours bar: hours worked against contracted hours, with the overtime shown
separately when there is any. The colours run the other way from the bar they replace — full is a
warning here, not good — and over 100% is allowed, because clamping it would hide the one thing the
lab manager says she cannot see. `staffLoadPercent` changed and nothing else did, which is the query
seam's third free absorption of a model change.

"On Break" becomes "On Overtime", counting people over their contracted hours this week.

### What it did to the lab

Four simulated weeks, same seeds, same naive assignment:

| | before B1 | after B1 |
|---|---|---|
| jobs completed | 475 | **538** |
| jobs late | 96 | **71** |
| rush orders missed | 18 | **13** |
| jobs abandoned | 7 | **0** |
| average backlog | 97.4 | **64.4** |

Overtime is worth about sixty jobs a month, and nothing is abandoned any more. Whether a lab manager
*wants* that trade is exactly the question the tool exists to put to her — B2 prices it, and the
answer may well be that sixty jobs cost more in premiums than they earn.

The cross-training comparison also moved, which is a caution about quoting any of these numbers early:
the penalty narrowed from −34 jobs to −24, and lateness went from +98 to **−18**. The decision now
looks mixed rather than clearly bad, on the same seeds, because of a change to a different part of
the model entirely.

**Verification.** 18 new tests. The ledger counts work rather than presence, agrees with the progress
the job records, and resets on the right boundaries. Overtime is zero inside a shift, counted for a
part-timer's afternoon, not charged for the slice that ends at closing, and arises in a running lab.
Fatigue is one at rest, slows work past the threshold by exactly the multiplier, and needs no
recomputation mid-step. The load bar reads contracted hours so a part-timer is judged fairly and can
exceed 100%. And energy is gone: no field, no break state, none appearing over a simulated week.

303 tests in total, and the suite now takes 48 seconds — most of it simulating weeks a minute at a
time, which B3 is what fixes.
