package com.familyhub.pro;

import android.content.ComponentName;
import android.content.Intent;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HomeAlerts")
public class HomeAlertsPlugin extends Plugin {
  private static HomeAlertsPlugin instance;

  @Override
  public void load() {
    instance = this;
  }

  static void emit(String source, String title, String text, long postedAt) {
    HomeAlertsPlugin p = instance;
    if (p == null) return;
    JSObject alert = new JSObject();
    alert.put("source", source);
    alert.put("title", title.length() > 120 ? title.substring(0, 120) : title);
    alert.put("text", text.length() > 300 ? text.substring(0, 300) : text);
    alert.put("postedAt", postedAt);
    p.notifyListeners("alert", alert);
  }

  @PluginMethod
  public void isEnabled(PluginCall call) {
    boolean enabled = NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName());
    JSObject r = new JSObject();
    r.put("enabled", enabled);
    call.resolve(r);
  }

  @PluginMethod
  public void openSettings(PluginCall call) {
    Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    getContext().startActivity(intent);
    call.resolve();
  }
}
