package io.github.finchett.tokify.timernotification

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val CHANNEL_ID = "running-timer"
private const val NOTIFICATION_ID = 7301

// The running timer as an ongoing notification. Its clock is Android's own
// chronometer, so it keeps counting while the app is closed.
class TokifyTimerNotificationModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("TokifyTimerNotification")

    Function("show") { title: String, text: String, startMs: Double ->
      show(title, text, startMs.toLong())
    }

    Function("hide") {
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
  }

  @SuppressLint("MissingPermission")
  private fun show(title: String, text: String, startMs: Long) {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "Running timer", NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val open = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val res = context.resources
    val icon = res.getIdentifier("notification_icon", "drawable", context.packageName).takeIf { it != 0 }
      ?: context.applicationInfo.icon
    val builder = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(text)
      .setWhen(startMs)
      .setShowWhen(true)
      .setUsesChronometer(true)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
      .setContentIntent(open)
    res.getIdentifier("notification_icon_color", "color", context.packageName).takeIf { it != 0 }?.let {
      builder.setColor(ContextCompat.getColor(context, it))
    }
    manager.notify(NOTIFICATION_ID, builder.build())
  }
}
