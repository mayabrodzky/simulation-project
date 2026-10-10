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

## A2 follow-up — one random sequence per entity

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
