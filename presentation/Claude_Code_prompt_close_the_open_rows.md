# Prompt to paste into Claude Code (VS Code) on your own machine

These close the "VERIFYING", "TO CONFIRM" and "not yet measured" rows on the scorecard slide. Run it in the NeuroStudy-Companion repo. Read-only except for the one test file it adds.

```
I am preparing my ITP2 presentation and need real numbers for four open scorecard rows. Be rigorous. Report only what you actually ran or queried, and say clearly when you could not run something.

1. 100 Hz low-pass filter (requirement #4). Read neuuro_bridge/NeuuroBridge.Core/LowPassFilter.cs and how BridgeController.HandleRawEeg uses it.
   a. Add a test (new file, same test style as the repo, or a small console harness in neuuro_bridge/tools if there is no test project) that builds LowPassFilter(100, 250, 4), feeds it sine tones at 10, 25, 50, 80, 100 and 120 Hz sampled at 250 Hz for at least 5 seconds, discards the first second as settling time, and measures steady-state amplitude gain in dB for each tone.
   b. Compare each gain with the theoretical 4th-order Butterworth response at 100 Hz (scipy.signal.butter(4, 100, fs=250, output='sos') + sosfreqz is fine for the reference). Expected: close to 0 dB at 10 and 25 Hz, about -3 dB at 100 Hz.
   c. Confirm by reading code that every stream described as "filtered" (eeg_filtered_samples, band powers, the live chart, the PDF, ML features) is derived from this filter's output, and list any that are not.
   d. Output a table: tone Hz | measured gain dB | reference gain dB | difference.

2. 24 placeholder images (requirement #1, O5). Find where OASIS stimulus images are stored (db migrations, backend, the stimulus set tables). Report how many of the 900 images have a real image file versus a placeholder, how many have valence, arousal and a quadrant, and how many of the 24 images shown in the standard protocol are affected. Give me the exact SQL or command you used.

3. Live chart redraw latency (NFR-PE-1, target <= 250 ms). Look at the rolling live chart code in neuuro_bridge/NeuuroBridge.Wpf. Tell me whether there is already any timing or logging I can use. If not, propose the smallest possible instrumentation (a Stopwatch around the redraw, logged at debug level, behind a flag) and show the diff WITHOUT applying it. Do not change bridge behaviour.

4. EEG loss for bridge 1.0.13. Write the read-only SQL (using the per-session loss logic from migration 014) that lists every completed session recorded on bridge version 1.0.13: session id, date, duration, percent of EEG lost. Do not run it against production; just give me the query and the command to run it.

Finish with a 10-line summary I can read before presenting. Do not commit anything.
```

## After it finishes, update these on the slides

| Slide | Row | Replace with |
|---|---|---|
| 3 Scorecard | Stored EEG cut above 100 Hz: `VERIFYING` | `MET` or `NOT MET` plus the measured gain at 100 Hz (move the row to backup if MET) |
| 3 Scorecard | Every image shows valence and arousal: `TO CONFIRM` | `MET` or `PARTLY MET` with the real placeholder count |
| 3 Scorecard | Chart redraw: `NOT MEASURED` | Keep as is unless you time it |
| 4 Signal reliability | 1.0.13 box and the EEG-loss row | Mean loss and n once 5+ sessions of 15+ min exist |

If you update a row from open to met, change the banner counts on slide 3 (10 / 19 and "9 open rows") and the opening of the slide 3 script.
