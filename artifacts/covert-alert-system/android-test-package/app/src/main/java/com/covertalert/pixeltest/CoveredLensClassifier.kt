package com.covertalert.pixeltest

import java.util.Locale

/**
 * Decides whether a camera lens is physically covered (pocket, box,
 * face-down on a table) from a ~1 s luminance probe: frame statistics plus
 * the light and proximity sensor readings taken during the same window.
 *
 * The gate only fires on a UNIFORM black frame corroborated by a sensor; any
 * visible structure or any uncertainty means capture proceeds — losing real
 * evidence is worse than uploading a black artifact.
 *
 * Residual ambiguity (accepted, journaled): a truly pitch-black room with
 * nothing near the proximity sensor produces the same signals as a box.
 * Until the physical-Pixel calibration run tunes the thresholds, the uniform-
 * black + dark-ambient combination is treated as covered and its signals are
 * journaled so the decision is auditable in the console.
 *
 * Pure Kotlin with no Android imports so the JVM unit tests can pin every
 * branch with synthetic statistics.
 */
object CoveredLensClassifier {
    /**
     * Calibration knobs — one place, ready for the physical-Pixel tuning
     * task. Luma values are on the 8-bit Y scale (0..255); variance is the
     * population variance of subsampled Y samples within one frame.
     */
    /** Mean Y at or below this reads as a black frame. */
    const val MAX_COVERED_MEAN_LUMA = 8.0
    /** Y variance at or below this reads as a uniform (structureless) frame. */
    const val MAX_UNIFORM_VARIANCE = 4.0
    /** Ambient lux at or below this corroborates a dark environment. */
    const val MAX_COVERED_LUX = 2.0f

    data class FrameStats(val meanLuma: Double, val variance: Double)

    /**
     * The decision plus every signal it rested on, so the journal entry alone
     * explains why a lens was or was not skipped.
     */
    data class Decision(
        val covered: Boolean,
        val reason: String,
        val stats: FrameStats,
        val lux: Float?,
        val proximityNear: Boolean?,
    ) {
        /** Compact audit line for the EVIDENCE_CAPTURE journal `detail`. */
        val detail: String
            get() = String.format(
                Locale.US,
                "meanLuma=%.1f variance=%.1f lux=%s proximity=%s — %s",
                stats.meanLuma,
                stats.variance,
                lux?.let { String.format(Locale.US, "%.1f", it) } ?: "unavailable",
                proximityNear?.let { if (it) "near" else "far" } ?: "unavailable",
                reason,
            )
    }

    fun classify(stats: FrameStats, lux: Float?, proximityNear: Boolean?): Decision {
        if (stats.meanLuma > MAX_COVERED_MEAN_LUMA) {
            return Decision(false, "frame is not black — capturing", stats, lux, proximityNear)
        }
        if (stats.variance > MAX_UNIFORM_VARIANCE) {
            return Decision(false, "dark frame but visible structure — capturing", stats, lux, proximityNear)
        }
        // Uniform black frame. Require sensor corroboration before skipping.
        if (lux != null) {
            return if (lux <= MAX_COVERED_LUX) {
                // Also the signature of a pitch-black room; accepted and
                // journaled (see class doc) until field calibration.
                Decision(true, "uniform black frame, ambient dark — covered", stats, lux, proximityNear)
            } else {
                // Ambient light is on but the frame is uniformly black:
                // something is blocking this lens specifically.
                Decision(true, "uniform black frame in lit ambient — lens blocked", stats, lux, proximityNear)
            }
        }
        if (proximityNear == true) {
            return Decision(true, "uniform black frame, proximity near — covered", stats, lux, proximityNear)
        }
        return Decision(false, "uniform black frame but no sensor corroboration — capturing to be safe", stats, lux, proximityNear)
    }
}
