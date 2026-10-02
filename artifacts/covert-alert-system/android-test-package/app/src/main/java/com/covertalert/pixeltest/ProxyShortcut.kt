package com.covertalert.pixeltest

import android.content.Context
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.drawable.Drawable
import androidx.core.content.getSystemService

/**
 * Pinned-shortcut disguise for the Gate 0A proxy trigger.
 *
 * The pinned home-screen shortcut must look like the selected cover app (its
 * real launcher label and icon) so a casual observer sees nothing unusual,
 * while a small red dot in the upper-right lets the legitimate user pick the
 * trigger out at a glance. The disguise is rebuilt from the current
 * [TestStore.coverPackage] selection every time and updated in place via
 * [ShortcutManager.updateShortcuts], so changing or clearing the cover app
 * re-skins the already-pinned shortcut without a manual re-pin.
 *
 * The shortcut always targets TriggerActivity by explicit component
 * ([IntentFactory.proxy]): action-only implicit intents are silently dropped
 * by several launchers, which was the no-journal tap failure.
 */
object ProxyShortcut {
    // Distinct from the legacy manifest shortcut's "gate0a-proxy" ID: a pinned
    // shortcut sharing a manifest ID pins the manifest entry's immutable
    // metadata instead of this disguise, and removing that manifest entry
    // would permanently disable pins made by older builds on upgrade.
    const val ID = "gate0a-proxy-pin"
    const val LEGACY_ID = "gate0a-proxy"

    /** Builds the shortcut as it should look right now (cover-aware). */
    fun build(context: Context): ShortcutInfo {
        val builder = ShortcutInfo.Builder(context, ID)
            .setIntent(IntentFactory.proxy(context))
        val cover = coverAppearance(context)
        if (cover != null) {
            builder.setShortLabel(cover.label)
                .setLongLabel(cover.label)
                .setIcon(android.graphics.drawable.Icon.createWithBitmap(composeMarker(context, cover.icon)))
        } else {
            // No cover app selected: fall back to the generic test identity,
            // still carrying the marker so the user can spot the trigger.
            val label = context.getString(R.string.proxy_shortcut_label)
            builder.setShortLabel(label)
                .setLongLabel(context.getString(R.string.proxy_shortcut_long_label))
                .setIcon(
                    android.graphics.drawable.Icon.createWithBitmap(
                        composeMarker(context, requireNotNull(
                            androidx.core.content.ContextCompat.getDrawable(context, R.drawable.ic_proxy)))
                    )
                )
        }
        return builder.build()
    }

    /**
     * Re-skins the already-pinned (or dynamic) shortcut in place after the
     * cover selection changed. No-op when the shortcut was never pinned.
     */
    fun updateInPlace(context: Context) {
        val manager = context.getSystemService<ShortcutManager>() ?: return
        val tracked = manager.pinnedShortcuts.any { it.id == ID } ||
            manager.dynamicShortcuts.any { it.id == ID }
        if (!tracked) return
        runCatching { manager.updateShortcuts(listOf(build(context))) }
    }

    private data class CoverAppearance(val label: String, val icon: Drawable)

    /**
     * Resolves the selected cover app's launcher label and icon through its
     * launcher activity (not the application record), matching what the home
     * screen itself shows. Null when no cover app is selected or installed.
     */
    private fun coverAppearance(context: Context): CoverAppearance? {
        val pkg = TestStore.coverPackage(context)
        if (pkg.isBlank()) return null
        val launch = context.packageManager.getLaunchIntentForPackage(pkg) ?: return null
        val resolved = context.packageManager.resolveActivity(launch, 0) ?: return null
        return CoverAppearance(
            label = resolved.loadLabel(context.packageManager).toString(),
            icon = resolved.loadIcon(context.packageManager)
        )
    }

    /**
     * Draws the base icon onto a bitmap and composites the marker: a small red
     * dot with a thin light halo in the upper-right. The dot's outer edge stays
     * inside the circle inscribed in the icon (center ~ (0.78, 0.22) of the
     * icon, outer radius ~ 0.09 of the size), so circular and squircle launcher
     * masks cannot clip it, and it never overlaps the launcher's own badge,
     * which sits in the lower-right on Android 8+.
     *
     * A tiny "CAS" monogram was considered and rejected as the default marker:
     * text renders poorly at shortcut sizes and clips under masking. If a
     * monogram is ever wanted instead, draw it here in place of the dot —
     * keep the same inset bounds.
     */
    private fun composeMarker(context: Context, base: Drawable): Bitmap {
        val density = context.resources.displayMetrics.density
        val size = (108 * density).toInt().coerceAtLeast(48)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        base.setBounds(0, 0, size, size)
        base.draw(canvas)
        val radius = size * 0.072f
        val cx = size * 0.78f
        val cy = size * 0.22f
        val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF5F6F2.toInt() }
        val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFD32F2F.toInt() }
        canvas.drawCircle(cx, cy, radius * 1.3f, halo)
        canvas.drawCircle(cx, cy, radius, dot)
        return bitmap
    }
}
