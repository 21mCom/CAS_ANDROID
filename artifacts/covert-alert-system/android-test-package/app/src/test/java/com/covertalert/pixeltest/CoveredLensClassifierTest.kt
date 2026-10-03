package com.covertalert.pixeltest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the covered-lens gate's decision table with synthetic frame
 * statistics. The contract: skip ONLY a uniform black frame corroborated by
 * a sensor; every dark-but-real scene and every uncertain reading captures.
 * If the field-calibration run retunes the thresholds in
 * CoveredLensClassifier, these cases must still classify the same way.
 */
class CoveredLensClassifierTest {

    private fun classify(
        mean: Double,
        variance: Double,
        lux: Float?,
        near: Boolean?,
    ) = CoveredLensClassifier.classify(CoveredLensClassifier.FrameStats(mean, variance), lux, near)

    // Pocket: uniform black frame, dark ambient, proximity near.
    @Test
    fun pocket_uniformBlackDarkAmbientNear_isCovered() {
        val decision = classify(mean = 1.5, variance = 0.8, lux = 0.0f, near = true)
        assertTrue(decision.covered)
    }

    // Box: uniform black, dark ambient — proximity may or may not trigger.
    @Test
    fun box_uniformBlackDarkAmbient_noProximity_isCovered() {
        val decision = classify(mean = 2.0, variance = 1.0, lux = 0.5f, near = null)
        assertTrue(decision.covered)
    }

    // Face-down on a lit table: ambient sensor reads dark (blocked),
    // proximity near.
    @Test
    fun faceDownOnLitTable_uniformBlack_isCovered() {
        val decision = classify(mean = 0.5, variance = 0.2, lux = 1.0f, near = true)
        assertTrue(decision.covered)
    }

    // Lit room, lens blocked (finger/tape over the camera): lux reads high
    // but the frame is uniformly black — the lens specifically is covered.
    @Test
    fun litRoomBlockedLens_uniformBlack_isCovered() {
        val decision = classify(mean = 3.0, variance = 1.2, lux = 320.0f, near = false)
        assertTrue(decision.covered)
    }

    // Uniform black with only proximity corroboration (no light sensor
    // reading): still covered.
    @Test
    fun noLightSensor_proximityNear_isCovered() {
        val decision = classify(mean = 2.0, variance = 0.9, lux = null, near = true)
        assertTrue(decision.covered)
    }

    // Dark scene with visible structure (night street, dim room contents):
    // variance above the uniformity bound must ALWAYS capture.
    @Test
    fun darkButStructured_captures() {
        val decision = classify(mean = 5.0, variance = 40.0, lux = 0.3f, near = true)
        assertFalse(decision.covered)
    }

    // Dim but readable scene: mean above the black bound captures even when
    // the frame is fairly smooth.
    @Test
    fun dimScene_captures() {
        val decision = classify(mean = 22.0, variance = 3.0, lux = 4.0f, near = false)
        assertFalse(decision.covered)
    }

    // Normal lit scene: far above both bounds.
    @Test
    fun litScene_captures() {
        val decision = classify(mean = 130.0, variance = 900.0, lux = 300.0f, near = false)
        assertFalse(decision.covered)
    }

    // Borderline: mean exactly at the black bound still counts as black…
    @Test
    fun borderlineMeanAtBound_isCovered() {
        val decision = classify(
            mean = CoveredLensClassifier.MAX_COVERED_MEAN_LUMA,
            variance = 1.0, lux = 0.0f, near = true,
        )
        assertTrue(decision.covered)
    }

    // …and one step above it captures.
    @Test
    fun borderlineMeanAboveBound_captures() {
        val decision = classify(
            mean = CoveredLensClassifier.MAX_COVERED_MEAN_LUMA + 0.5,
            variance = 1.0, lux = 0.0f, near = true,
        )
        assertFalse(decision.covered)
    }

    // Borderline variance exactly at the uniformity bound counts as uniform…
    @Test
    fun borderlineVarianceAtBound_isCovered() {
        val decision = classify(
            mean = 2.0, variance = CoveredLensClassifier.MAX_UNIFORM_VARIANCE,
            lux = 0.0f, near = true,
        )
        assertTrue(decision.covered)
    }

    // …and one step above it captures even with dark ambient + near proximity.
    @Test
    fun borderlineVarianceAboveBound_captures() {
        val decision = classify(
            mean = 2.0, variance = CoveredLensClassifier.MAX_UNIFORM_VARIANCE + 0.5,
            lux = 0.0f, near = true,
        )
        assertFalse(decision.covered)
    }

    // Uncertainty fails OPEN: uniform black but neither sensor available
    // (no light sensor, proximity silent) — capture rather than risk
    // skipping real evidence.
    @Test
    fun uniformBlackWithNoCorroboration_captures() {
        val decision = classify(mean = 1.0, variance = 0.5, lux = null, near = null)
        assertFalse(decision.covered)
    }

    // Proximity explicitly FAR with no lux reading: no corroboration,
    // capture. (With a lux reading the lux branch alone decides.)
    @Test
    fun uniformBlackProximityFarNoLux_captures() {
        val decision = classify(mean = 1.0, variance = 0.5, lux = null, near = false)
        assertFalse(decision.covered)
    }

    // Auditability: the journaled detail must carry every signal the
    // decision rested on, so the console can explain a skip after the fact.
    @Test
    fun decisionDetail_carriesAllSignals() {
        val covered = classify(mean = 1.5, variance = 0.8, lux = 0.0f, near = true)
        assertTrue(covered.detail.contains("meanLuma=1.5"))
        assertTrue(covered.detail.contains("variance=0.8"))
        assertTrue(covered.detail.contains("lux=0.0"))
        assertTrue(covered.detail.contains("proximity=near"))

        val unavailable = classify(mean = 1.0, variance = 0.5, lux = null, near = null)
        assertTrue(unavailable.detail.contains("lux=unavailable"))
        assertTrue(unavailable.detail.contains("proximity=unavailable"))
        // Journal detail is capped at 500 chars server-side; stay well under.
        assertTrue(covered.detail.length <= 500)
    }
}
