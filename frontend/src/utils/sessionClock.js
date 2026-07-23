import { getServerTime } from '@/utils/api'

const SAMPLE_COUNT = 5

let calibrated = false
let serverOffsetMs = 0

const epochFromPerformance = monotonicTime => performance.timeOrigin + monotonicTime

export async function calibrateSessionClock() {
    const samples = []

    for (let index = 0; index < SAMPLE_COUNT; index++) {
        const startedAt = performance.now()
        const response = await getServerTime()
        const finishedAt = performance.now()

        if (!response.ok)
            continue

        const data = await response.json()
        const serverEpoch = Date.parse(data.server_time)

        if (!Number.isFinite(serverEpoch))
            continue

        const roundTripMs = finishedAt - startedAt

        const browserMidpointEpoch = epochFromPerformance((startedAt + finishedAt) / 2)

        samples.push({
            roundTripMs,
            offsetMs: serverEpoch - browserMidpointEpoch
        })
    }

    if (!samples.length)
        throw new Error('Unable to calibrate the session clock')

    samples.sort((left, right) => left.roundTripMs - right.roundTripMs)

    const bestSample = samples[0]

    serverOffsetMs = bestSample.offsetMs
    calibrated = true

    return {
        offset_ms: bestSample.offsetMs,
        round_trip_ms: bestSample.roundTripMs
    }
}

export function resetSessionClock() {
    calibrated = false
    serverOffsetMs = 0
}

export function getSessionTimestamp(monotonicTime = performance.now()) {
    const browserEpoch = epochFromPerformance(monotonicTime)

    const correctedEpoch = calibrated
        ? browserEpoch + serverOffsetMs
        : browserEpoch

    return new Date(correctedEpoch).toISOString()
}
