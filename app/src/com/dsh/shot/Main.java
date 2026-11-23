package com.dsh.shot;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.File;

/**
 * 极简界面 + adb 触发入口。通过 adb 可以直接要一张图：
 *   am start -n com.dsh.shot/.Main -a com.dsh.shot.SHOT --es path /data/local/tmp/shot.png
 * 截完把结果写进 logcat（tag=Shot）并以 "SHOT_OK <path> <bytes>" 标记。
 */
public class Main extends Activity {
    public static final String ACTION_SHOT = "com.dsh.shot.SHOT";
    private static final String TAG = "Shot";
    private static Main alive = null;
    private TextView status;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        alive = this;
        appCtx = getApplicationContext();
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(48, 48, 48, 48);
        root.setBackgroundColor(Color.WHITE);

        status = new TextView(this);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        status.setTextColor(Color.BLACK);
        status.setPadding(0, 0, 0, 32);
        root.addView(status, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button open = new Button(this);
        open.setText("打开无障碍设置");
        open.setOnClickListener(v -> {
            try { startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); } catch (Throwable ignored) {}
        });
        root.addView(open);

        Button shot = new Button(this);
        shot.setText("截图");
        shot.setOnClickListener(v -> {
            String[] err = new String[1];
            String p = defaultPath();
            long n = ShotService.shotToFile(p, 10, err);
            status.setText(n > 0 ? ("截图成功 " + n + " 字节\n" + p)
                    : ("截图失败：" + (err[0] == null ? "未知" : err[0])));
        });
        root.addView(shot);

        setContentView(root);
        refresh();
        handleIntent(getIntent());
    }

    @Override protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        setIntent(it);
        handleIntent(it);
    }

    private void handleIntent(Intent it) {
        if (it == null || !ACTION_SHOT.equals(it.getAction())) return;
        final String path = it.getStringExtra("path") != null ? it.getStringExtra("path") : defaultPath();
        Log.i(TAG, "收到截图请求 → " + path);
        new Thread(() -> {
            String[] err = new String[1];
            long n = ShotService.shotToFile(path, 15, err);
            if (n > 0) Log.i(TAG, "SHOT_OK " + path + " " + n);
            else Log.e(TAG, "SHOT_FAIL " + (err[0] == null ? "未知" : err[0]));
            new Handler(Looper.getMainLooper()).post(() -> {
                if (alive != null && alive.status != null) {
                    alive.status.setText(n > 0 ? ("截图成功 " + n + " 字节\n" + path)
                            : ("截图失败：" + (err[0] == null ? "未知" : err[0])));
                }
                // 让 shell 侧的 am start 命令能尽快结束
                if (it.getBooleanExtra("finish", false)) finish();
            });
        }, "shot-main").start();
    }

    public static String defaultPath() {
        try {
            java.io.File d = Main.appCtx != null ? Main.appCtx.getFilesDir() : null;
            if (d != null) {
                if (!d.exists()) d.mkdirs();
                return new java.io.File(d, "shot.png").getAbsolutePath();
            }
        } catch (Throwable ignored) {}
        return "/data/local/tmp/shot.png";
    }

    public static android.content.Context appCtx = null;

    @Override protected void onResume() { super.onResume(); refresh(); }
    @Override protected void onDestroy() { if (alive == this) alive = null; super.onDestroy(); }

    private void refresh() {
        boolean on = ShotService.ready();
        status.setText("无障碍：" + (on ? "已连接 ✅" : "没连上 ❌")
                + "\n截图默认写私有目录 shot.png");
    }

    public static void onServiceReady() {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (alive != null) { try { alive.refresh(); } catch (Throwable ignored) {} }
        });
    }
}
