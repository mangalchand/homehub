package com.familyhub.pro;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import java.util.HashMap;
import java.util.Map;

/**
 * Mirrors notifications from installed home-security apps (Ring, Blink, myQ…) into FamilyHub.
 * Runs only after the user grants Notification access in Android settings. Every other app is ignored.
 */
public class HomeAlertListener extends NotificationListenerService {
  static final Map<String, String> SOURCES = new HashMap<>();
  static {
    SOURCES.put("com.ringapp", "ring");
    SOURCES.put("com.immediasemi.android.blink", "blink");
    SOURCES.put("com.chamberlain.myq.chamberlain", "myq");
    SOURCES.put("com.oceanwing.battery.cam", "eufy");
    SOURCES.put("com.google.android.apps.chromecast.app", "google-home");
    SOURCES.put("com.nest.android", "nest");
    SOURCES.put("com.arlo.app", "arlo");
    SOURCES.put("com.simplisafe.mobile", "simplisafe");
    SOURCES.put("com.hualai", "wyze");
  }

  @Override
  public void onNotificationPosted(StatusBarNotification sbn) {
    String source = SOURCES.get(sbn.getPackageName());
    if (source == null || sbn.isOngoing()) return;
    Notification n = sbn.getNotification();
    if (n == null || (n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
    Bundle extras = n.extras;
    CharSequence title = extras.getCharSequence(Notification.EXTRA_TITLE);
    CharSequence text = extras.getCharSequence(Notification.EXTRA_TEXT);
    if (title == null && text == null) return;
    HomeAlertsPlugin.emit(source, title == null ? "" : title.toString(), text == null ? "" : text.toString(), sbn.getPostTime());
  }
}
