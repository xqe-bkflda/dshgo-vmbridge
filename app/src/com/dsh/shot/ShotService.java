package com.dsh.shot;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityService.ScreenshotResult;
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.util.Log;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.Executor;

/** 无障碍服务：用 takeScreenshot 截图，绕开虚拟机里坏掉的 gralloc mapper。 */
public class ShotService extends AccessibilityService {
    private static final String TAG = "Shot";
    private static volatile ShotService INSTANCE = null;

    public static ShotService get() { return INSTANCE; }
    public static boolean ready() { return INSTANCE != null; }

    @Override public void onServiceConnected() {
        INSTANCE = this;
        Log.i(TAG, "无障碍已连接");
        Main.onServiceReady();
    }

    @Override public void onDestroy() {
        INSTANCE = null;
        super.onDestroy();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent e) {}
    @Override public void onInterrupt() {}

    /** 回调不能跑在主线程（调用方可能在主线程上等），给它一条独立线程 */
    private static final Executor WORKER = new Executor() {
        @Override public void execute(Runnable r) {
            Thread t = new Thread(r, "shot-cb");
            t.setDaemon(true);
            t.start();
        }
    };

    /** 截一张，返回 PNG 字节；失败返回 null 并把原因写进 err[0] */
    public static byte[] shotSync(int timeoutSec, String[] err) {
        final Object lock = new Object();
        final byte[][] holder = new byte[1][];
        final String[] eholder = new String[1];
        final boolean[] done = new boolean[1];
        ShotService svc = INSTANCE;
        if (svc == null) { if (err != null) err[0] = "无障碍服务没连上"; return null; }
        try {
            svc.takeScreenshot(Display.DEFAULT_DISPLAY, WORKER, new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    Bitmap bmp = null;
                    HardwareBuffer hb = null;
                    try {
                        hb = r.getHardwareBuffer();
                        Bitmap hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
                        if (hw != null) bmp = hw.copy(Bitmap.Config.ARGB_8888, false);
                        if (bmp != null) {
                            ByteArrayOutputStream bo = new ByteArrayOutputStream();
                            bmp.compress(Bitmap.CompressFormat.PNG, 100, bo);
                            holder[0] = bo.toByteArray();
                        } else {
                            eholder[0] = "wrapHardwareBuffer 返回 null";
                        }
                    } catch (Throwable t) {
                        eholder[0] = String.valueOf(t);
                    } finally {
                        if (bmp != null) bmp.recycle();
                        try { if (hb != null) hb.close(); } catch (Throwable ignored) {}
                        synchronized (lock) { done[0] = true; lock.notifyAll(); }
                    }
                }
                @Override public void onFailure(int code) {
                    eholder[0] = "takeScreenshot 失败 code=" + code;
                    synchronized (lock) { done[0] = true; lock.notifyAll(); }
                }
            });
        } catch (Throwable t) {
            if (err != null) err[0] = String.valueOf(t);
            return null;
        }
        synchronized (lock) {
            long end = System.currentTimeMillis() + timeoutSec * 1000L;
            while (!done[0]) {
                long left = end - System.currentTimeMillis();
                if (left <= 0) break;
                try { lock.wait(left); } catch (InterruptedException ignored) {}
            }
        }
        if (!done[0] && eholder[0] == null) eholder[0] = "超时没等到回调";
        if (err != null) err[0] = eholder[0];
        return holder[0];
    }

    /** 截一张写到 path，返回字节数（0 = 失败） */
    public static long shotToFile(String path, int timeoutSec, String[] err) {
        byte[] png = shotSync(timeoutSec, err);
        if (png == null) return 0;
        try {
            File f = new File(path);
            File p = f.getParentFile();
            if (p != null && !p.exists()) p.mkdirs();
            FileOutputStream fo = new FileOutputStream(f);
            fo.write(png);
            fo.close();
            Log.i(TAG, "写入 " + path + " " + png.length + " 字节");
            return png.length;
        } catch (Throwable t) {
            if (err != null) err[0] = String.valueOf(t);
            return 0;
        }
    }
}
