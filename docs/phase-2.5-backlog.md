# Phase 2.5 — the visual and interaction backlog

Items deferred to the redesign phase, gathered here because they were accumulating as scattered
asides across a long engineering log and a list that is hard to find is not a list.

Phase 2.5 sits between the model work and the "what if?" comparison, and its goal is **clarity, not
looks**: a lab manager should be able to tell what the lab is doing, and what a decision would change,
without being walked through it. Each item below says what is wrong and why it was not fixed at the
time.

## The brief

- A visible **goal on first load**. Right now the page opens and waits.
- **Fewer things on screen.** Seven panels compete for attention with no hierarchy.
- **Plain language** throughout, replacing simulation vocabulary.
- A **three or four step walkthrough** instead of an empty lab.
- A **visual language for comparison**, which Phase 4 then uses to show two options side by side.
- One **usability test** with the lab manager, against a task rather than a demo.

## Deferred defects

| | |
|---|---|
| **Walking speed is physically indefensible** | 1.2 grid units a simulated minute — roughly 1.2 metres a minute against a human pace of eighty. Correcting it recovers about 2% of capacity (measured: 4.8 of 240 rostered hours a week) and makes the sprites cross the lab in a fraction of a second at ×1, because one real second is one simulated minute. The tension is between a model that is right and a picture that is legible, and the honest resolution — the engine charging realistic minutes while the renderer animates the trip over real time — needs the renderer to know about journeys. Belongs with whoever owns the speed controls. |
| **The assign dialogue caps at twelve rows** | A backlog of a hundred and fifty is realistic; a dialogue of a hundred and fifty rows is not. The cap keeps the live lab usable and is not a design. |
| **Buying a second machine names it wrongly** | Buying another microscope in sandbox produces a second "Microscope B" rather than a "Microscope C". A5 makes capacity a count of interchangeable instruments rather than a set of names, which changes what naming even means here. |
| **Save navigates away in demo mode** | 💾 Save shows "Sign in to save your sessions" and then goes to `login.html`, losing the session it offered to save. |
| **`fromBusinessProfile` invents demand** | A work type needs a weekly volume, a variation and a deadline; the onboarding form asks for none of them, so that path produces a plausible simulation of nothing in particular. Either the form asks, or the path stops presenting itself as a model of a real business. |
| **Props render as desks** | Every prop type falls through to one sprite. |
| **The view layer is one untyped file** | 1,100 lines with type checking suppressed. It holds no simulation rules — it reads the world, renders it, and turns clicks into commands — but it is the last place a typo is not caught at build time, and two shipped defects (`setHtmlById`, the stale work-type id) were of exactly that kind. |
| **Position is accumulated instead of derived** | A walking person's position is integrated one slice at a time: `x += (dx / dist) * speed * dt`. At the live view's step — a sixtieth of a second — that is hundreds of thousands of additions, and the rounding error reaches about 1e-9, which is exactly the tolerance `isArrived` uses to decide whether somebody has reached a machine. So the dust can flip an arrival into the adjacent slice, and from there the run diverges from the same seed stepped coarsely. It is the last known reason a *watched* run can differ from the batch run that produced a number, and it is the only one left that is not a logic error — three of those were found and fixed in entry 34. **The fix is to stop accumulating and make position a pure function of the clock**: store origin, target and departure instant, and compute where somebody is from the time elapsed. Every caller then agrees by construction rather than by an argument about which events exist, which is the same lesson as the dispatch cadence in entry 33. Contained to `moveStaff`, the arrival clamp in `nextEventIn`, and three fields on `Staff`; the renderer still reads `x`/`y` and needs no change. Deliberately out of the Phase 2 pull request — it is a correctness change to movement, and it wants its own commit and its own sub-minute invariance test rather than riding in with a phase. |
| **Panels disagree about freshness** | Fixed for the staff panel, but the underlying split is still "driven by events" against "driven by the clock", decided per panel by hand. Worth making a property of a panel rather than a line in the game loop. |

## Findings that are not defects

Recorded so they are not "fixed" by accident. Each is a true thing about the lab that the simulation
is correctly reporting, and each is the kind of sentence the product exists to produce.

- **The junior researcher holds no skills**, so forty rostered hours a week can never be used by
  anyone. Measured as the single largest component of the 92.5 hours a week of on-shift idle time.
- **The manager's three skills match two steps** in the whole catalogue, giving another 26.7 idle
  hours a week.
- **Nobody rostered can complete a DNA/PCR or a cell culture alone**, so those jobs must change hands
  between specialists. Handover is now modelled; how long a part-finished job waits for its second
  specialist is a real cost and currently has no presentation.
