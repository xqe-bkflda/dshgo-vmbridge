package com.dsh.shot;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.File;

/**
 * 用广播触发截图，不依赖 Activity 生命周期：
 *   am broadcast -a com.dsh.shot.SHOT --es path /data/user/0/com.dsh.shot/files/shot.png
 * 截图结果写 logcat（tag=Shot）：SHOT_OK <path> <bytes> / SHOT_FAIL <原因>
 */
public class ShotReceiver extends BroadcastReceiver {
    private static final String TAG = "Shot";

    @Override public void onReceive(final Context ctx, final Intent it) {
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            // 进程可能是被这条广播拉起来的，无障碍要等它连上
            long waitEnd = System.currentTimeMillis() + 15000L;
            while (!ShotService.ready() && System.currentTimeMillis() < waitEnd) {
                try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            }
            if (!ShotService.ready()) {
                Log.e(TAG, "SHOT_FAIL 无障碍服务没连上（先在设置里启用 Shot）");
                return;
            }
            String path = it != null ? it.getStringExtra("path") : null;
            if (path == null || path.length() == 0) {
                File f = new File(app.getFilesDir(), "shot.png");
                path = f.getAbsolutePath();
            }
            String[] err = new String[1];
            long n = ShotService.shotToFile(path, 20, err);
            if (n > 0) Log.i(TAG, "SHOT_OK " + path + " " + n);
            else Log.e(TAG, "SHOT_FAIL " + (err[0] == null ? "未知" : err[0]));
        }, "shot-recv").start();
    }
}
