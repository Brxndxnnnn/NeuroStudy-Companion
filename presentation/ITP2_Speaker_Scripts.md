# NeuroStudy ITP2: speaker scripts

Total budget 20 min including the demo video. About 140 words per minute. Word counts are in brackets; trim a few sentences if you run long in rehearsal.

## 1. Title
**Speaker:** Brandon  |  **Time:** 0:15  |  **Words:** 31

Good afternoon. We are SE Team 2, presenting NeuroStudy Companion for QIROM. ITP2 turned a working prototype into a tool a clinic can run the same way every time, and trust.

## 2. Objectives and scope
**Speaker:** Zhao Yu  |  **Time:** 1:30  |  **Words:** 211

ITP1 ended with one platform from the headset to the browser: a Windows bridge, a time-series database, an API gateway, an ML service and a web app, all deployed together. We are not repeating that. The architecture is unchanged.

What changed is that the client then used it. They came back with fourteen requirements. Thirteen are in this codebase; number fourteen, database access for an overseas partner, was handled outside it.

We grouped them into five objectives, in priority order. One: standardise the session, with a 13-step protocol started from the bridge, and WHO-5 and BFI-2 scoring. Two: reports and data lifecycle, with a one-click PDF, admin deletion and a scheduled cleanup. Three: trust the live signal, with a 10-second chart, blink and clench detection and our own 100 Hz filter. Four: redesign the ML. Five: admin configurability.

On the right are four enhancements added during the trimester, either requested by the client or proposed by us and agreed. Signal reliability, E1, turned into the largest stream of work. Each row shows who led it.

One thing the plan could not foresee: on 21 October the client redirected two things. Group models instead of personal ones, and signal quality as the core concern. That shaped everything you are about to see.

## 3. Scorecard: what is not yet met
**Speaker:** Eugene  |  **Time:** 1:30  |  **Words:** 190

We set 19 success criteria across the five objectives and four enhancements. Ten are met, and those are in backup. All thirteen in-scope requirements are live in production.

This slide shows only the nine that are not fully met, because those are the ones worth your time.

Three are open. The chart redraw time feels smooth but was never formally timed. The 100 Hz filter is built and in use, and we are confirming its response with test tones. And the image tooltip: we are confirming the last placeholder images.

Two are partly met. Blinks are labelled live for about 80 percent of deliberate blinks. And the headband stayed connected for 17 minutes, past its 10-minute cut-off, but that is one session.

Four are not met. Clench detection live is unreliable because it depends on electrode contact. EEG loss is still 21 percent on average. The group model does not yet beat predicting the mean. And the CNN-LSTM stretch goal was not built. Brandon explains the loss and Zhengda the model.

We also changed five things from the plan, with reasons, and added four client enhancements. Both are in backup.

## 4. Signal reliability
**Speaker:** Brandon  |  **Time:** 1:30  |  **Words:** 200

The hardest problem was not in the requirements. Sessions lost their EEG about ten minutes in, often ruining the second baseline. Across many sessions, 13 to 55 percent of packets never arrived.

Connection tuning and rendering changes were not the cause. Logging showed the drop came ten minutes after the Bluetooth connection, so we asked Neeuro, with logs, rather than send unconfirmed commands to borrowed hardware.

On 10 November they confirmed it: the headband powers itself off after ten minutes if its heart-rate sensor is off and it sees no movement. That describes a client sitting still with their eyes closed. They gave us the command to disable it. Bridge 1.0.11 sent it, but it never reached the band, because the SDK keeps the command channel to itself. Bridge 1.0.13 sends it through the SDK's own connection, and on 20 November the band stayed connected for 17 minutes.

Now the honest part. This chart shows session-level loss has not improved yet: 21 percent against 20 in ITP1. Those sessions all predate the fix. We have not yet measured 1.0.13 at session level.

Also fixed on the way: a wrong-unit impedance figure, and EEG stamped one second late. Now, the demo.

## 5. Demo video
**Speaker:** Brandon, Zhao Yu, Eugene, Zhengda  |  **Time:** 7:15 plus buffer  |  **Words:** 334

(Narrate over the video. One handover per chapter. Hand over with the name of the next speaker before the chapter ends.)

0:00 CONNECT AND START (Brandon). We pair the bridge with the website using a one-time code, check electrode contact with the new impedance button, and press Start Session on the bridge. The website waits for the technician. That is requirement 8, and E1 in action.

1:15 LIVE SIGNAL (Brandon). A rolling 10-second chart. Violet dashed lines are blinks, orange are clenches. Blinks are detected on T3 and T4 because the headband's reference sits beside Fp1 and Fp2 and cancels the blink there. Clench is limited by electrode contact, which is why it is a not-met row.

2:00 13-STEP PROTOCOL (Brandon). Time-lapse: countdown, eyes-closed and eyes-open baselines, 24 images, mental maths, second baselines, then the survey. Every phase is stored as a marker in the database, so the PDF and the models can cut the session into blocks without guessing from timestamps. Over to Zhao Yu.

2:45 QUESTIONNAIRES AND IMAGE HOVER (Zhao Yu). BFI-2 and WHO-5 are scored by one database view, so the bridge, website, PDF and models all agree on a score. Hovering an image shows valence, arousal and emotion quadrant. Over to Eugene.

3:30 COMMENTARY, HISTORY, PDF TIMER (Eugene). The client's intake history and the technician's commentary travel with the EEG. The PDF button stays disabled until commentary is written. Watch the timer: median 1.9 seconds, against a 10-second target.

4:45 ADMIN: INTERVAL AND DELETION (Eugene). Admin sets the image interval from 1 to 60 seconds; the value is copied onto each session when it is claimed. Deletion needs a confirmation and removes every dependent row in one transaction. Over to Zhengda.

5:45 ML GROUPS AND COMPARISON (Zhengda). A technician builds a group, training runs in the background, and the page shows the held-out score next to the baseline it must beat. Comparing a client with a group answers the client's question, in neutral wording: within or outside the group's range.

## 6. ML evaluation
**Speaker:** Zhengda  |  **Time:** 1:45  |  **Words:** 239

O4 was not about accuracy. It was about choosing the algorithm by a fair test, and leaving a pipeline that improves by itself as sessions are recorded.

This is random forest valence, on three people, 766 two-second epochs and 24 images. The first bar is a random split: R-squared of plus 0.36. That looks like a working model. But every epoch of an image carries the same label, so a random split puts near-copies of the same image in both training and testing.

The second bar holds out the person and the image: minus 0.27. That is the number a new person seeing a new image would actually get. The third bar is simply predicting the average rating: minus 0.18. So, honestly, no model beats the baseline yet.

We still chose random forest, and the client confirmed it. It was the only model to beat the baseline in the per-client round. It had the lowest error, every member scored between minus 0.39 and minus 0.12, and it trains in about three seconds. SVM and XGBoost were close. Ridge, our ITP1 choice, was clearly worse, and the MLP failed badly.

We cut the CNN-LSTM for four reasons: too little data, signal that was not clean until November, the client fixing random forest on 21 October, and limited hours.

The pipeline is finished. Every completed session becomes training data automatically. What is missing is data, and each group page says so.

## 7. Limitations, lessons, handover
**Speaker:** Zhao Yu  |  **Time:** 1:45  |  **Words:** 190

Four limitations. First, data: three people and 24 labels is the ceiling, so more people and more varied images come first. Second, the Tier 2 models wait for enough clean sessions; the code to score them exists. Third, no validation against a true measure of attention or affect, and no usability study with technicians. Fourth, governance: a data protection impact assessment and consent wording before any employer-facing use, and the bridge installer is not yet code-signed.

Three lessons. Measure it, with n: a value is only as trustworthy as your understanding of how it was produced, and our impedance figure looked plausible for a whole trimester while measuring nothing. Plan the data, not just the code: the pipeline finished before there was data to learn from. And ask the vendor sooner, with evidence: we investigated for weeks, and a precise question got an answer in days.

For a next team: handover docs and an open-issues list, a data collection plan for the models, a database that builds from the migrations alone, and an update feed so bridge fixes reach clinics without reinstalling.

Thank you. We are happy to take questions.

