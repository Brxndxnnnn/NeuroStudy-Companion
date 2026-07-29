#!/usr/bin/env python3
"""
Measure how much EEG the SenzeBand actually delivered, from the vendor SDK's own log.

    python neuuro_bridge/tools/analyse_sdk_log.py logs/639170721558258951.txt
    python neuuro_bridge/tools/analyse_sdk_log.py logs/            # every log in a folder

WHY THIS EXISTS
---------------
The headset samples a true 250 Hz, but only ~80% of it reaches the PC. This script
measures that from the SDK's log alone — no database, no bridge changes, no
instrumentation. That makes it the before/after metric for any attempt to improve
delivery (see "RUNNING THE EXPERIMENTS" below).

HOW THE MEASUREMENT WORKS
-------------------------
The SDK's packet structure makes the arithmetic exact:

    BLE notification            80 bytes
    package                    645 bytes = 45 header + 600 payload (150 B/channel)
    5 packages -> counter 750 B/channel / 3 bytes per 24-bit sample = 250 samples/ch
    -> exactly ONE filteredDataDelegate callback per 1.000 s of EEG

So counting `filteredDataDelegate?.Invoke` lines against the session's wall-clock span
gives seconds-delivered vs seconds-elapsed directly. Loss events are 1 s granular: a
missing callback is a missing second.

The log's timestamps are whole seconds, so spans carry about +-1 s. Negligible over a
long session, worth remembering on a 60 s one.

WHERE THE LOSS HAPPENS
----------------------
Reported per stage, because they have different causes:

  * short packages  - a package that reached "Full Package is received!" at 565 bytes
                      instead of 645, i.e. one 80-byte notification vanished in transit.
                      The SDK discards the whole package.
  * header resyncs  - "Cannot find Header!" scans. After a short package the parser is
                      misaligned in the byte stream and burns ~7 more notifications
                      re-locking. This is why one lost chunk costs ~8x its own size.

RUNNING THE EXPERIMENTS
-----------------------
Both are zero-code and use this script as the measurement. Record a normal session,
then run it on the newest file in the SDK's log folder.

  1. DISTANCE  - one session with the band next to the PC, one across the room.
                 Similar loss  => a throughput/capacity limit, not RF.
                 Much worse far away => RF matters and placement is a real mitigation.

  2. ADAPTER   - one session on the built-in radio, one on a USB Bluetooth dongle.
                 Different controllers allow different numbers of packets per
                 connection event, so if loss drops, the ceiling was the adapter.

Compare the LOSS line across runs. Anything under a few percent difference is noise at
these session lengths.
"""

from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

SAMPLES_PER_CALLBACK = 250          # = 1.000 s of EEG at 250 Hz
PACKAGES_PER_CALLBACK = 5
FULL_PACKAGE_BYTES = 640            # last accumulation step before "Full Package"

TS = re.compile(r"^\[(\d+)/(\d+)/(\d+) (\d+):(\d+):(\d+) ([ap]m)\]", re.IGNORECASE)


def seconds_of_day(line: str) -> int | None:
    m = TS.match(line)
    if not m:
        return None
    h, mi, s, ampm = int(m.group(4)), int(m.group(5)), int(m.group(6)), m.group(7).lower()
    if ampm == "pm" and h != 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    return h * 3600 + mi * 60 + s


def analyse(path: Path) -> dict | None:
    callbacks: list[int] = []
    package_end_bytes: list[int] = []
    counts = Counter()
    last_buffer = None

    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if "filteredDataDelegate?.Invoke" in line:
                t = seconds_of_day(line)
                if t is not None:
                    callbacks.append(t)
            elif "sbInstance.intBufferCount=" in line and "byteBuffer.Length" in line:
                m = re.search(r"intBufferCount=(\d+)", line)
                if m:
                    last_buffer = int(m.group(1))
            elif "Full Package is received" in line:
                counts["packages_received"] += 1
                if last_buffer is not None:
                    package_end_bytes.append(last_buffer)
            elif "analyzeEEGDataThread sbInstance.counter" in line:
                counts["packages_analyzed"] += 1
            elif "Cannot find Header" in line:
                counts["header_resyncs"] += 1

    if len(callbacks) < 2:
        return None

    span = callbacks[-1] - callbacks[0]
    delivered = len(callbacks) * SAMPLES_PER_CALLBACK / 250.0
    expected = span + 1                       # inclusive of the first callback's own second
    loss_pct = 100.0 * (1 - delivered / expected) if expected > 0 else 0.0

    gaps = [b - a for a, b in zip(callbacks, callbacks[1:]) if b - a > 1]
    short_packages = sum(1 for b in package_end_bytes if b != FULL_PACKAGE_BYTES)

    return {
        "file": path.name,
        "span_s": span,
        "delivered_s": delivered,
        "expected_s": expected,
        "loss_pct": loss_pct,
        "callbacks": len(callbacks),
        "gaps": gaps,
        "short_packages": short_packages,
        **counts,
    }


def report(r: dict) -> None:
    print(f"\n=== {r['file']} ===")
    print(f"  session span        : {r['span_s']:>8.0f} s")
    print(f"  EEG delivered       : {r['delivered_s']:>8.1f} s  ({r['callbacks']} callbacks x 1.000 s)")
    print(f"  EEG expected        : {r['expected_s']:>8.0f} s")
    print(f"  LOSS                : {r['loss_pct']:>8.1f} %")

    if r["gaps"]:
        hist = sorted(Counter(r["gaps"]).items())
        print(f"  missing seconds     : {sum(g - 1 for g in r['gaps']):>8d} across {len(r['gaps'])} gap(s)")
        print(f"  gap spacing (s:n)   : {hist}")

    received = r.get("packages_received", 0)
    analyzed = r.get("packages_analyzed", 0)
    if received:
        print(f"  packages received   : {received:>8d}")
        print(f"  packages analysed   : {analyzed:>8d}  ({100.0 * analyzed / received:.1f}% of received)")
        print(f"  short packages      : {r['short_packages']:>8d}  (one 80-byte notification lost each)")
        print(f"  header resyncs      : {r.get('header_resyncs', 0):>8d}  (notifications burned re-locking)")

    verdict = ("healthy" if r["loss_pct"] < 5
               else "degraded" if r["loss_pct"] < 15
               else "SEVERE")
    print(f"  verdict             : {verdict}")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    target = Path(argv[1])
    files = sorted(target.glob("*.txt")) if target.is_dir() else [target]
    if not files:
        print(f"No log files found in {target}")
        return 1

    results = [r for r in (analyse(f) for f in files) if r]
    if not results:
        print("No sessions with EEG found. Are these SenzeBand SDK logs?")
        return 1

    for r in results:
        report(r)

    if len(results) > 1:
        mean = sum(r["loss_pct"] for r in results) / len(results)
        worst = max(results, key=lambda r: r["loss_pct"])
        print(f"\n{len(results)} session(s): mean loss {mean:.1f}%, "
              f"worst {worst['loss_pct']:.1f}% ({worst['file']})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
