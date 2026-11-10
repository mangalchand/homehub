package com.familyhub.pro;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Wall displays should stay on; the web app dims itself with night mode and the photo screensaver.
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  @Override
  public void onResume() {
    super.onResume();
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
  }

  /** Back never closes the app: a wall display must stay in the foreground until someone leaves it on purpose (Home button or Android screen pinning). */
  @Override
  public void onBackPressed() {
    if (bridge != null && bridge.getWebView() != null && bridge.getWebView().canGoBack()) {
      bridge.getWebView().goBack();
    }
  }
}
