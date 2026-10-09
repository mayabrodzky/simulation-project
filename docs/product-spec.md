# Polaris — Lab Scenario Product Spec (v0, illustrative)

> **Status:** working assumptions, not validated data. Every number here is a placeholder chosen to make the model behave realistically (a lab running near capacity with one clear bottleneck). Each assumption must be editable in the UI (Phase 4 "assumptions panel") and should later be checked with the real lab manager — see *Open questions*.
>
> **Use:** input for Phase 2 (engine + real metrics), Phase 2.5 (redesign) and Phase 4 ("What if?"). Where this spec conflicts with today's code, this spec wins.

---

## 1. The user and the question she asks

**Persona:** Dana, manager of a mid-size testing lab that runs sample analyses for external clients. Paid per sample, with turnaround-time (TAT) commitments. Not technical; thinks in shekels, deadlines and people.

**What she needs from Polaris:** *"Before I spend money, show me whether this decision will actually fix my problem — and what it will cost me if I'm wrong."*

**Her current pain points** (the model must be able to show these):

1. **Mass spectrometry is the bottleneck.** One instrument, only two trained operators. Samples queue there; deadlines slip.
2. **Rush orders get missed.** Clients pay a premium for 24h turnaround; when the lab is full, those are the ones that hurt most.
3. **One senior person carries the lab.** The most multi-skilled scientist is overloaded and accumulates overtime; if she's sick, everything stops.
4. **Overtime is expensive and invisible** until payroll arrives.

---

## 2. The decisions to compare (Phase 4 presets)

| # | Decision | Monthly cost | What it changes | Why it's interesting |
|---|---|---|---|---|
| A | **Hire a generalist technician** | ₪16,000 (loaded) | +1 staff, skills: Centrifuge, Microscopy, Spectrophotometry | Intuitive choice — but doesn't touch the mass-spec bottleneck |
| B | **Lease a second mass spectrometer** | ₪12,000 | +1 Mass Spectrometer | Doubles machine capacity, but still only 2 operators |
| C | **Add an evening shift** (2 people, 16:00–22:00, Sun–Thu) | ~₪9,000 shift premium | Existing equipment usable 6 more hours/day | Uses current assets harder; affects overtime and fatigue |
| D | **Cross-train 2 technicians on mass spec** | ₪6,000 one-off + 2 weeks at 50% productivity for both | 4 operators instead of 2 | Cheapest; short-term pain for long-term capacity |

The model must also support **combinations** (e.g. B + D) and a **"do nothing"** baseline. The interesting outcome to be able to *test* (not assume): decisions interact — B alone may underperform because people, not machines, become the constraint.

---

## 3. A normal week in the lab

**Working time:** Sun–Thu, 08:00–16:00 (40 h/week per full-time person). Simulation horizon: **4 weeks**, after a 1-week warm-up that's excluded from results.

### 3.1 Work types (replace today's 3 tasks and the "emergency" concept)

| Work type | Arrivals / week | Hands-on time | Equipment (in order) | Required skills | Price | Deadline |
|---|---|---|---|---|---|---|
| Blood panel | 80 (±20%) | 45 min | Centrifuge → Microscope | Centrifuge, Microscopy | ₪180 | 2 working days |
| DNA / PCR test | 40 (±20%) | 90 min + 2 h machine | PCR → Spectrophotometer | PCR, Spectrophotometry | ₪650 | 5 working days |
| Cell culture assay | 12 (±25%) | 3 h spread over 3 days + 48 h incubation | Biosafety Cabinet → Incubator → Microscope | Biosafety, Incubator, Microscopy | ₪1,400 | 7 working days |
| Mass spec analysis | 30 (±20%) | 60 min prep + 90 min instrument | Mass Spectrometer | Mass Spectrometry | ₪900 | 5 working days |

- Arrivals are random within the range (Poisson-like), spread over the week.
- **Machine time ≠ people time.** During instrument run time the operator is free for other work, but the instrument is occupied.
- **Rush orders** (replaces "emergencies"): 10% of incoming jobs of any type are flagged rush → deadline 24 h, price +50%. Missing a rush deadline = lose the premium + 30% refund.
- **Regular late delivery:** 20% discount on that job.

> Sanity check: demand ≈ 186 hands-on hours + ~20% overhead ≈ 223 h vs 240 h capacity (≈93% load). Mass spec instrument needs ~45 h/week vs 40 h available in one shift → **structural bottleneck**, which is exactly the situation the decisions are meant to address.

### 3.2 Staff (keep today's 8 people, adjust skills)

| Person | Role | Hours | Skills |
|---|---|---|---|
| Dr. Amit Katz | Senior scientist | Full-time | Microscopy, PCR, Mass Spectrometry, Biosafety |
| Dr. Michal Levi | Lab manager's deputy | Full-time | Spectrophotometry, Incubator, Biosafety |
| Dana Cohen | Technician | Full-time | Centrifuge, Microscopy |
| Hadas Ben Hamo | Technician | Full-time | Centrifuge, Microscopy, Spectrophotometry |
| Dr. Lihi Dayan | Scientist | Full-time | Mass Spectrometry, Spectrophotometry, PCR |
| Amir Barzilay | Junior technician | Full-time | Centrifuge |
| Nina Zur | Technician | Part-time (20 h) | Biosafety, Microscopy, Incubator |
| Alex Tom | Junior technician | Part-time (20 h) | Spectrophotometry |

*(The persona's name and the staff names are fictional; rename freely.)*

**People rules:**
- Loaded cost: ₪100/h full-time, ₪90/h part-time.
- Overtime: first 2 h/day at 125%, beyond that 150%. Max 12 h/day.
- Sick days: 3% chance per person per day.
- **Fatigue (replaces "Energy %")**: modelled only through measurable effects — after 45 h in a week, a person's tasks take 10% longer and error/rework chance rises from 2% to 5%. No abstract energy bar.

### 3.3 Equipment

| Instrument | Count | Breakdown (mean time between) | Repair | Repair cost |
|---|---|---|---|---|
| Mass Spectrometer | 1 | every ~6 weeks | 1–3 days | ₪4,000 |
| PCR Machine | 1 | every ~10 weeks | 1 day | ₪1,500 |
| Centrifuge, Microscope, Spectrophotometer, Incubator, Biosafety Cabinet | 1 each | every ~12 weeks | 0.5–1 day | ₪800 |

Preventive calibration (₪500, 2 h, monthly) halves breakdown chance for that month. Breakdown events are random but seeded.

### 3.4 Fixed costs and materials

- Rent, utilities, admin: ₪60,000/month (fixed — same in every option).
- Materials: 25% of each job's price.
- Drop the separate "Materials" and "Samples" counters from the header; materials become a cost line.
- **Currency: ₪** throughout (the user is an Israeli lab).

---

## 4. What the manager sees (metrics)

For each option, run **~300 seeded simulations** of the 4-week horizon and report median plus a range (P10–P90):

| Metric | Plain-language label in UI |
|---|---|
| Monthly profit vs. baseline | "You'll earn about ₪X more / less per month" |
| On-time delivery % | "Orders delivered on time" |
| Rush orders missed | "Urgent orders you'd miss" |
| Backlog at end of horizon | "Work still waiting at month end" |
| Overtime hours (team total + most-loaded person) | "Overtime — and who's carrying it" |
| Instrument utilization | "How busy each machine is" (highlight >90%) |
| Bottleneck | "What's holding the lab back" (one sentence) |

### Verdict card (example of tone, not a real result)

> **Cross-train 2 technicians on mass spec — ✅ Worth it**
> Costs ₪6,000 once. In about 8 out of 10 simulated months you earn ₪18,000–₪31,000 more, mostly because mass-spec work stops queuing. Urgent orders missed drop from ~6 to ~1 a month. Amit's weekly hours fall from 52 to 44.
> *Biggest assumption: mass-spec demand stays around 30 samples a week. If it grows past 40, you'll also need decision B.*

Rules for the verdict card: one headline, one sentence of money, one sentence of service, one sentence about people, one "biggest assumption" line. No tables.

---

## 5. Mapping to today's code (for Claude Code)

| Today | Becomes |
|---|---|
| Random "emergencies" with arbitrary reward/penalty | Rush orders: a flag on normal incoming work (§3.1) |
| `energy` % and wandering-for-rest | Hours worked, overtime, fatigue slowdown (§3.2) |
| 3 task definitions | 4 work types with hands-on vs. machine time (§3.1) |
| `money` starting at 25,000 | Monthly P&L: revenue − people − materials − fixed − repairs − decision cost |
| Materials / Samples counters | Removed from header; materials = cost per job |
| Manual "Assign Task" as the core loop | Stays for the **live view**; the What-if engine uses an automatic dispatcher (earliest-deadline-first, then skill match) |
| `$` | `₪` |

Keep the engine domain-agnostic (resources, capabilities, work types, events); everything above lives in `src/scenarios/chemistryLab.ts` + `Tuning`.

---

## 6. Out of scope (for now)

- Client-specific contracts, pricing negotiations, quality audits.
- Hiring lead time and onboarding beyond the fixed 2-week ramp for decision D.
- Multi-month seasonality.
- Free-text "AI advisor" questions (listed under Next steps).

## 7. Open questions to validate with a real lab manager

1. Are the four work types and their volumes in the right ballpark?
2. Is mass spec (or something else) really the bottleneck?
3. What does a missed deadline actually cost — money, or client trust?
4. Which of the four decisions has she actually considered in the last year?
5. Would she trust a verdict more with a range ("₪18k–31k") or a single number?
6. What would make her stop trusting the tool?

### Added while building the model (Phase 2)

Three modelling assumptions that this spec does not settle, where a reading had to be chosen to
write the code. Each is a `Tuning` value or a scenario field, so a different answer is a data change
rather than a rewrite.

7. **The cell culture assay.** "3 h spread over 3 days + 48 h incubation" does not map onto a step
   sequence. It is modelled as three steps — biosafety cabinet 120 min attended, incubator 15 min
   attended then 48 h unattended, microscope 45 min attended. That keeps the three hours of hands-on
   time and the 48-hour wait, but turns "spread over 3 days" into "whenever the incubation
   finishes". Is the spread load-bearing — does someone have to come back on specific days — or is
   it just describing how it feels?
8. **When does a client give up?** The spec has partial credit for lateness but no point at which a
   job stops being worth doing. Modelled as abandonment **3 working days past the deadline**, with
   the work written off. Does that happen at all, and if so after how long?
9. **How are the hands-on minutes split across the steps of a job?** The spec gives a total per work
   type, not a per-step breakdown — but the split decides which instrument is the bottleneck. The
   numbers chosen reproduce this spec's own claim that mass spec binds first; a different split makes
   the microscope bind instead. This is the single assumption most worth checking, because it
   silently determines the answer to the question the whole tool exists to ask.
