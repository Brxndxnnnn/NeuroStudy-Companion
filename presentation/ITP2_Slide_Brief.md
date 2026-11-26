# NeuroStudy ITP2: slide-by-slide brief for the team

Total 19 min, 1 min spare. Sequence is fixed. This document says what each slide must achieve, who builds it, exactly what goes on it, and what the speaker must be able to say and defend.

| Slides | Owner | Time | Content |
|---|---|---|---|
| 1-3 | Brandon | 2:00 | Title, scope, the objective |
| 4-5 | Zhao Yu | 2:00 | Objectives, who owned what |
| 6-7 | Eugene | 2:00 | Scorecard (met, then not met) |
| 8 | Brandon | 8:00 | Demo |
| 9-10 | Zhengda | 3:00 | ML evaluation, ITP1 vs ITP2 |
| 11 | Zhao Yu | 2:00 | Limitations, lessons, handover |
| 12-13 | all | Q&A | Q&A, Thank you |

Handovers (say the next person's name): Brandon -> Zhao Yu -> Eugene -> Brandon -> Zhengda -> Zhao Yu. Five in total.

## Rules for everyone

1. **What the panel marks (rubric A4, 15%):** key achievements AND understanding of the domain (delivery and coverage); organised, visual slides; smooth handovers. The demo and Q&A (A5, 25%) test technical depth, and the reflective reports are used to pick the questions. So every slide should show a result and one decision you can defend.
2. **No "TBC", "DRAFT" or "n/a" on any slide.** Replace with a measured number, or "not yet measured: reason, plan".
3. **Every number carries its n and its source** (report section or table). If you cannot point to where it is in the report, do not put it on the slide.
4. **Do not read the slide out.** The slide is the evidence; the speaker says the reasoning.
5. **Slides must match the report.** The panel has read both. If a number differs, fix one of them (see "Known mismatches" at the end).
6. **Minimum text size 14 pt for body, 12 pt for table cells.** One message per slide; if it needs more, move detail to backup.
7. **Do not repeat ITP1:** problem statement, literature review, tech-stack choices, the full architecture walkthrough, the SDLC loop. One sentence at most, with "unchanged since ITP1".
8. **Same visual style for all slides** (grey background, charcoal panels, yellow accent, status colours teal = met, amber = partly met, coral = not met, grey = open). Title slide format: `ALL CAPS` title, top-left, same position on every slide.

---

## Slides 1-3 (Brandon, 2:00 total)

### Slide 1: Title (0:10)
- **Purpose:** identify the team and project.
- **On the slide:** ICT3217 Integrative Team Project 2; NeuroStudy Companion; SE_TEAM_2 with names and IDs; QIROM Consulting, Mr Daud, Mr Rashid. Add one subtitle line: *"ITP2: from a working prototype to a tool a clinic can run and trust."*
- **Say:** one sentence. "We are SE Team 2, and this is NeuroStudy Companion for QIROM."

### Slide 2: Scope / agenda (0:20)
- **Purpose:** show the panel the structure so they can follow the handovers.
- **On the slide:** keep the 6-item list but match it to the real order: 1 ITP2 scope: where ITP1 left off; 2 Objectives O1-O5 and E1-E4; 3 Who owned what; 4 What we achieved: the scorecard; 5 Demo; 6 Evaluation, limitations, handover. Add each speaker's first name on the right of their item.
- **Say:** "Six parts, four speakers." Do not read the items.

### Slide 3: The objective (1:30)
- **Purpose:** in 90 seconds, set up what ITP1 left us with, what the client asked for, and why the work is harder than "add features". This is the only ITP1 recap.
- **Current problem:** the slide is three paragraphs with typos ("What changed What hasn't changed"). Make it three short blocks.
- **On the slide (three blocks, 2 lines each, 16 pt):**
  - **WHERE ITP1 LEFT OFF.** One platform from headset to browser: Windows bridge, time-series database, API gateway, ML service, web app, all deployed. Architecture unchanged in ITP2.
  - **WHAT CHANGED.** The client used it and approved 14 new requirements (13 in this codebase; #14, overseas partner access, handled outside). On 21 Oct they redirected two things: **group models** instead of personal models, and **signal quality** as the core concern.
  - **WHY IT MATTERS.** Real client, requirements that changed mid-trimester, changes to a live system holding clinical data, results we measure, not just demonstrate.
- **Visual:** keep the target illustration on the left. Optionally add three small stat tiles under the blocks: `14 requirements` | `19 success criteria` | `11 bridge releases (1.0.4 to 1.0.13)`.
- **Say:** the story of the trimester in one breath: "The client used the platform, told us it was not yet something a clinic could run the same way every time, and halfway through changed two things that reshaped our work."
- **Must be able to answer (Q&A):** Why did the client change to group models? (Use case is comparing a person with a team; per-client models had too little data. Report 4.4.2.) What is a requirement we did not do? (CNN-LSTM; requirement #14 handled outside the codebase.)
- **Handover line:** "Zhao Yu will take you through the five objectives."

---

## Slides 4-5 (Zhao Yu, 2:00 total)

### Slide 4: Objectives (1:15)
- **Purpose:** state what we committed to and in what priority, and show which ones the client added.
- **Current problem:** a bare list. Add owner and the requirement numbers so the panel can trace objective -> requirement.
- **On the slide:** five rows in priority order, each with number, name, one-line scope, requirement numbers, lead:

| # | Objective | Scope | Reqs | Lead |
|---|---|---|---|---|
| 01 | Standardise the session | 13-step protocol, Start on the bridge, WHO-5 and BFI-2 | #3 #8 #10 #11 | Brandon |
| 02 | Reports and data lifecycle | One-click PDF, admin deletion, scheduled cleanup | #6 #7 | Brandon, Eugene |
| 03 | Trust the live signal | 10 s chart, blink and clench detection, 100 Hz filter | #4 #5 #9 | Brandon |
| 04 | Redesign the ML | Remove global model, benchmark Tier 1, emotion quadrants | #12 #13 | Zhengda, Brandon |
| 05 | Admin configurability | Image tooltips, adjustable image interval | #1 #2 | Eugene, Zhao Yu |

  Dark right panel **ADDED DURING THE TRIMESTER**: E1 Signal reliability; E2 Client histories and session commentary; E3 Survey response view and PDF; E4 Group comparison and ML groups usability. Footer line: "Requested by the client or proposed by the team, agreed with the supervisor."
- **Say:** the priority order was our scheduling tool. Weekly hours were about a quarter of ITP1's (4-6 h per member), so O1/O2 were committed, O5 and Tier 2 were the designated first cuts. Nothing important was dropped by accident. E1 was not planned and became the largest stream of work.
- **Must be able to answer:** Why this priority order? (Report 11.1/11.6.) Why did O5 finish early if it was the first cut? (Capacity was better than feared early on; it was delivered in full anyway.)

### Slide 5: Who owned what (0:45)
- **Purpose:** show every member had a real, distinct technical ownership.
- **Current problems:** E3 row is empty, a typo ("reponses"), and Zhengda only appears on O3/O4. A matrix of dots shows nothing about what each person did.
- **On the slide:** keep the matrix (fix E3, typos, spacing) and add a right-hand column **"MAIN DELIVERABLES"** per person (taken from report Table 21 so it agrees with the report):
  - **Brandon (lead):** Start on the bridge, 13-step protocol UI, live chart, blink/clench detection, 100 Hz filter, impedance check, auto-off fix, group models and comparison, all signal-reliability work.
  - **Eugene:** database migrations 015-027, admin deletion, 30-day cleanup and backups, interval setting, intake history and commentary APIs, WHO-5/BFI-2 database scoring, CI upgrade, production runs.
  - **Zhengda:** global model removal, model registry and Tier 1 benchmark (ridge, random forest, SVM, XGBoost, MLP), held-out evaluation design.
  - **Zhao Yu:** protocol on the website, BFI-2 and WHO-5 forms and results-page scores, tooltip, admin interval control, survey response view.
- **ACTION for all four:** read your line and correct it. The report's Table 21 and the project plan's Table 2 differ slightly; the slide must be true and agree with the report.
- **Say:** "Read nothing out." Name who leads each objective and say each person owned their component end to end, with the schema as the contract between us.
- **Handover line:** "Eugene will show you the scorecard."

---

## Slides 6-7 (Eugene, 2:00 total)

### Slide 6: Scorecard 1/2, what is met (0:40)
- **Purpose:** show that the committed scope is real, with evidence, in 40 seconds.
- **Current problem:** two dense 10-row tables. Re-split: slide 6 = met, slide 7 = not met.
- **On the slide:**
  - Top banner (three tiles): **10 / 19** criteria met; **13 / 13** in-scope requirements live in production; **4** enhancements delivered beyond the brief.
  - Under it, 10 compact rows (OBJ | criterion | evidence). All status `MET` (teal):
    1. O1 Every protocol run records all 9 phases: 6 of 6 full runs; 6 more stopped early (n = 12 sessions).
    2. O1 WHO-5 and BFI-2 match published scoring: 0 mismatches (n = 30 BFI-2, 5 WHO-5 sessions).
    3. O2 PDF in 10 s or less: median 1.9 s, max 3.6 s (n = 8 runs, 2 full sessions).
    4. O2 Deleting a session leaves 0 dependent rows: 12 tables checked.
    5. O2 Cleanup removes only unclaimed sessions older than 30 days: 9 daily runs, 0 stale rows.
    6. O2 A backup can be restored: restored in 14 s, 8 of 8 counts match (n = 1).
    7. O4 Global model removed; Tier 1 tested on held-out people and images: 5 algorithms compared.
    8. O4 Every OASIS image has an emotion quadrant: 900 of 900.
    9. O5 Interval 1-60 s enforced at all 3 layers: 60 accepted, 61 rejected.
    10. E2 Report needs a published commentary: DB triggers, backend tests.
- **Say:** do not read rows. "Ten criteria are met, each with evidence you can check. I will spend the time on the ones that are not." 
- **Eugene's own rows:** know rows 3-6, 9 cold. Likely questions: how do you test the cascade? (12 tables, integration test using the app role, control session untouched.) How does the cleanup avoid deleting real data? (Single atomic DELETE; only unclaimed sessions older than 30 days; completed sessions only deleted by an admin.)

### Slide 7: Scorecard 2/2, what is not yet met (1:20)
- **Purpose:** be honest about gaps and show we understand each one. This slide earns credit for critical analysis.
- **On the slide:** one table of the 9 open rows (OBJ | criterion | evidence | status), 13 pt, status colour-coded:

| OBJ | Criterion | Evidence | Status |
|---|---|---|---|
| O3 | Live chart redraws in 250 ms or less | Smooth in use; not formally timed | NOT MEASURED |
| O3 | Blinks labelled live | About 80% of deliberate blinks; replay 10/10 | PARTLY MET |
| O3 | Clenches labelled live | Replay 3/3; unreliable live (electrode contact) | NOT MET |
| O3 | Stored EEG cut above 100 Hz | Causal Butterworth in use; tone test result here | MET or NOT MET (see to-do) |
| O4 | Group model beats predicting the mean | R² valence -0.27 vs baseline -0.18 (3 people) | NOT MET |
| O4 | Tier 2 CNN-LSTM (stretch) | Not built; MLP tested and failed | NOT MET |
| O5 | Image tooltip on every image | 900 rated; placeholder count to confirm | MET or PARTLY MET |
| E1 | Headband stays connected > 10 min | 17 min, n = 1 | PARTLY MET |
| E1 | EEG reaches the database without loss | Mean 21% lost (n = 11); bridge 1.0.13 not yet measured | NOT MET |

  Footer: "Five divergences from plan and four client enhancements: backup."
- **To-do before presenting (Brandon runs these, see the Claude Code prompt in this folder):** close the 100 Hz tone test, the placeholder-image count, and, if you can, 5+ sessions of 15+ min on bridge 1.0.13. Update the three open rows and the banner counts when done. A status of "TBC" must not appear.
- **Say, in this order:** (1) the three open rows in one breath; (2) the two partly met; (3) the four not met, one sentence each with the cause, then "Brandon explains the loss, Zhengda explains the model". Finish with "None of these is hidden; each is in the report and each has a next step."
- **Why each is not met (Eugene must know):**
  - *Clench:* needs electrode contact on T3/T4; reliable in replay (3/3), not on a fitted headband.
  - *EEG loss:* the main cause was the headband's auto power-off; the fix only reached the band in 1.0.13, so earlier sessions still show loss.
  - *Beats the mean:* three people and 24 images is not enough data; the evaluation method is sound, the data is the gap.
  - *Tier 2:* cut first by the risk register, for data, signal, direction and capacity reasons (report 4.4.8).
- **Handover line:** "Brandon will now run the demo."

---

## Slide 8: Demo (Brandon, 8:00)

- **Purpose:** show every functional objective working end to end on the production system, with the technical reason for each design visible.
- **On the slide:** title **DEMO VIDEO**, chapter table (time | chapter | objective | owner of that feature), and a "WATCH FOR" box: violet = blink, orange = clench; Start Session on the bridge; phase markers; PDF in about 2 s; group model next to its baseline.
- **Chapters (7:15 + 0:45 spare):**

| Time | Chapter | Objective | Feature owner | What Brandon says |
|---|---|---|---|---|
| 0:00 | Connect and Start | E1, O1 | Brandon | Pairing code, impedance check (270-580 kΩ on a fitted band), Start on the bridge, website waits for the technician. **Also tell the signal story here in 40 s:** headband powered off after 10 min; fix confirmed by Neeuro; 17 min on 20 Nov. |
| 1:15 | Live signal: blinks, clench | O3 | Brandon | Rolling 10 s chart; blink on T3/T4 because the reference sits beside Fp1/Fp2; clench limited by electrode contact; 100 Hz causal Butterworth, sample by sample. |
| 2:00 | 13-step protocol (time-lapse) | O1 | Brandon, Zhao Yu | Countdown, eyes-closed and eyes-open baselines, 24 images, maths, second baselines, survey. Every phase is a database marker. |
| 2:45 | Questionnaires, image hover | O1, O5 | Zhao Yu | One database view scores BFI-2 and WHO-5 for bridge, website, PDF and ML; tooltip shows valence, arousal, quadrant. |
| 3:30 | Commentary, history, PDF timer | E2, E3, O2 | Eugene | Intake history, commentary gate, survey responses view, PDF timer. |
| 4:45 | Admin: interval, deletion | O5, O2 | Eugene | Interval 1-60 s copied onto each session at claim time; deletion with confirmation, one transaction. |
| 5:45 | ML groups and comparison | O4, E4 | Zhengda, Brandon | Build a group, background training, held-out score next to baseline, compare a client with a group in neutral wording. |

- **Because Brandon narrates all 8 minutes**, the owners of chapters 4-7 must give Brandon a **one-page cheat sheet** each (what is on screen, the 2 design decisions worth saying, one number). Deadline: before rehearsal 1. Better: each owner records or narrates their own chapter if rehearsal shows Brandon is stretched.
- **Prepare:** record at 1080p with big cursor, zoom to the active window, add short on-screen captions; keep a known-good second recording, and be ready to switch to live because A5 asks for "interactive". Use one test client with a completed session and a trained group so nothing waits on training.
- **Do not demonstrate** anything that has not been run on production this week. Decide in rehearsal what to cut if time runs short: first the admin chapter, then the survey responses.
- **Handover line:** "Zhengda will now show you what the measurements say."

---

## Slides 9-10 (Zhengda, 3:00 total)

### Slide 9: EEG loss and ML evaluation (1:30)
- **Purpose:** show measurement, not claims: the one result that did not improve (EEG loss) and the one that is a clean negative (ML).
- **Decision for the team:** the current slide 9 is the EEG-loss chart (Brandon's work). Keep it, but Zhengda must present both numbers, so use a split slide:
  - **Left:** the existing EEG-loss bar chart, smaller (11 sessions, bridge 1.0.4 to 1.0.12, mean 21% vs ITP1 20%; worst 33% vs ITP1 67%); callout "1.0.13: bench-confirmed 17 min; session-level loss not yet measured; plan n >= 5."
  - **Right:** a 3-bar chart, random forest valence R²: **+0.36** random split (leaky) | **-0.27** person-and-image held out | **-0.18** predict-the-mean baseline. Caption: "3 people, 766 epochs, 24 images."
- **Say (ML, 60 s):** "Same model, same data, scored two ways. The random split looks like a working model; it is not, because every epoch of an image carries the same label so near-copies sit in training and testing. The held-out score is what a new person would get, and it is below the baseline: no model beats it yet. We still chose random forest: only one to beat the baseline in the per-client round, lowest error, members all between -0.39 and -0.12, trains in about 3 s. SVM and XGBoost were close, ridge clearly worse, the MLP failed. The pipeline is finished; the missing piece is data."
- **Say (EEG loss, 30 s):** Brandon supplies the cause (headband auto power-off); Zhengda says what the chart shows and what has been fixed. **Brandon and Zhengda must rehearse this half together.**
- **Must be able to answer (Zhengda):** Why held-out by person and image? (Leak, report Table 9.) Why random forest and not XGBoost? (Report 4.4.7.) Why was CNN-LSTM not built? (Data, signal quality, client direction, capacity: 4.4.8.) What is R²? (0 = as good as predicting the average; negative = worse.) Does BFI-2 help? (Changed scores by less than 0.03: no.) How many epochs per image and what is an epoch? (2 s window, 50 features.)

### Slide 10: ITP1 vs ITP2 (1:30)
- **Purpose:** the "what changed because of the work" slide: same measures at both ends.
- **Current problem:** 10 dense rows, includes minor ones (database build, releases).
- **On the slide:** trim to 8 rows, 13 pt, columns MEASURE | END OF ITP1 | END OF ITP2 | n:
  1. EEG lost before the database | mean 20%, worst 67% | mean 21%, worst 33%; 1.0.13 not yet measured | 11 sessions (ITP1: 18)
  2. EEG time alignment | up to 3 s compressed | gaps recorded; real-time stamps (1.0.10) | -
  3. Longest continuous connection | about 10 min (auto power-off) | 17 min | 1 session
  4. Electrode contact figure | amplitude labelled as impedance | measured, 270-580 kΩ | fitted band
  5. Session report | written by hand | one click; median 1.9 s | 8 runs
  6. Session protocol | free-form | 13 steps, 9 recorded phases | 6 full runs
  7. Model evaluation | random split looked useful (+0.36) | held-out -0.27 vs baseline -0.18 | 3 people, 766 epochs
  8. Automated tests | backend 41, ML 134, frontend 2 files | backend 129, ML 168, frontend 8 files, DB integration test | -
  Colour the ITP2 cell: teal where better, grey where unchanged, coral where honest-worse. Footer: "Same measures at both ends; every figure carries its n."
- **Say:** pick three rows and tell them as before/after stories: reports (hand -> 1.9 s), model evaluation (looked useful -> honestly negative), contact check (measured nothing -> real kΩ). Mention row 1 as "unchanged so far, and here is why". Do not read all rows.
- **Handover line:** "Zhao Yu will close with what we learned and what we hand over."

---

## Slide 11: Limitations, lessons, handover (Zhao Yu, 2:00)

- **Purpose:** close with critical reflection, which is exactly what the reflective report and Q&A will probe.
- **Current problem:** "LESSONS (DRAFT, TBC)", tiny text, three bare lists.
- **On the slide (three columns, 14 pt) plus a dark "NEXT STEP" strip:**
  - **LIMITATIONS (report section 13):** (1) Data: 3 people and 24 labels is the ceiling; (2) Tier 2 models wait for enough clean sessions; (3) no validation against true attention or affect, no technician usability study; (4) governance: DPIA and consent before employer-facing use, installer not code-signed.
  - **THREE LESSONS** (each: what happened -> lesson):
    1. *Measure it, with n.* The impedance figure looked plausible for a whole trimester while measuring nothing: a value is only as trustworthy as your understanding of how it was produced.
    2. *Plan the data, not just the code.* The ML pipeline finished before there was enough data to learn from.
    3. *Ask the vendor sooner, with evidence.* Weeks of guessing the cause of the dropouts; days once we asked Neeuro a precise question.
  - **WHAT A NEXT TEAM GETS:** handover docs and an open-issues list; a data collection plan for the models; a database that builds from migrations alone; an update feed so bridge fixes reach clinics without reinstalling.
  - **NEXT STEP strip:** "Record more people on a wider range of images, then re-run the same benchmark script unchanged."
- **Say:** limitations in 30 s (state them, do not apologise); lessons in 60 s with one concrete example each; handover and thanks in 30 s. End on "Thank you, we are happy to take questions."
- **Must be able to answer:** Which lesson would change how you plan next time? (Schedule data collection from week 1.) How did you handle scope growth? (Priority order, new requests slotted after the committed objectives: report 11.1, 11.6.) Team conduct and use of feedback: Table 19 of the report.

---

## Slides 12-13: Q&A and Thank you
Keep both. On the Q&A slide add nothing. On Thank you keep names and IDs.

## Backup slides (not presented, ready for Q&A)
1. Planned vs actual (Table 22): five divergences, four enhancements.
2. Architecture diagram, marked "unchanged since ITP1".
3. Requirement status 1-14. Change the footer to: "13 in-scope requirements delivered; #14 handled outside this codebase; #12 without Tier 2."
4. Signal reliability: symptom, ruled out, cause, fix, also fixed (impedance, timing).
5. "Why we decided" answers: causal Butterworth vs FFT; group vs personal models; held-out split; how impedance is measured.
6. Full scorecard (all 19 rows), ownership matrix, test counts.

## Likely Q&A, by person (rubric A5: oral reasoning)

- **Brandon:** why is the blink detected on T3/T4, not Fp1/Fp2? (Reference electrode sits mid-forehead beside Fp1/Fp2, so a blink is common to channel and reference and cancels.) How did you measure impedance? (Single-bin DFT at the test frequency, Ohm's law, 2.2 kΩ series resistor.) Why is clench unreliable? What is the bridge's release process?
- **Eugene:** why forward-only migrations? How does row-level security protect clinics? How did you test the cascade and the backup restore? What does the cleanup job delete?
- **Zhengda:** see slide 9. Also how are features z-scored and why is BFI added after? (Constant within a session would become zeros.)
- **Zhao Yu:** how do technicians move through the website? How are BFI-2 and WHO-5 scored (reverse-keyed items, percentage)? Why one database view for the scores? How does the website stay in step with the bridge?
- **Everyone:** team conduct, how feedback changed the project (Table 19), what you would do differently.

## Known mismatches to fix before the slides are final
- Report Table 17 rates all five objectives "Achieved"; the scorecard shows not met rows. Say on slide 7 that objectives are achieved at the level the plan committed to, while specific success criteria are open. Optionally soften the report's wording.
- PDF time: report 8.5 says "within 7 seconds"; slides say median 1.9 s, max 3.6 s (timing script, 25 Nov). Update the report.
- "All 14 requirements delivered" (current backup) vs "13 in scope, #14 outside" (report). Use the second everywhere.
- Session counts: report 10.1 says 10 sessions recorded under the new protocol; the scorecard says 12 (6 full + 6 stopped early). Use one definition.
- Typos on current slides: "What changed What hasn't changed", "Survey reponses view", "Running  production".

## Suggested working order
1. Everyone: read this brief; each owner sends corrections to the person in charge of the slide.
2. Each owner drafts their slides to the content above, in the existing theme; send to Brandon.
3. Brandon: closes the open scorecard rows, merges, checks numbers against the report.
4. Rehearsal 1: full run-through with a timer; trim to 19 min. Rehearsal 2: handovers and demo timing. Rehearsal 3: Q&A drill using the list above.
