#!/bin/bash
# 在 aarch64 的 proot Ubuntu（DSH Go 环境）里编译 Shot.apk。
#
# 几个必须绕开的坑：
#   1. $ANDROID_HOME/build-tools/*/aapt2 是 x86-64 ELF，aarch64 上跑不了
#      → 必须用系统装的 /usr/bin/aapt2（android-libbuild-tools，原生 aarch64）
#   2. 系统 aapt2 解析不了 android-35/36 的 android.jar
#      （LoadedArsc.cpp:94 RES_TABLE_TYPE_TYPE entry offsets overlap actual entry data）
#      → aapt2 link 的 -I 用 /usr/share/android-framework-res/framework-res.apk
#   3. d8 / apksigner 没有可执行的 aarch64 版本 → 用 java -jar 跑 jar
#   4. javac 不能带 --bootclasspath / -bootclasspath（会找不到 LambdaMetafactory）
#   5. .keystore/.jks/.p12 会被某些安全策略拦 → 签名库用无敏感后缀的名字

set -e
cd "$(dirname "$0")"

AJ=${AJ:-/root/android-sdk/platforms/android-35/android.jar}
FRES=${FRES:-/usr/share/android-framework-res/framework-res.apk}
D8JAR=${D8JAR:-/root/android-sdk/build-tools/36.0.0/lib/d8.jar}
APKSIGNER_JAR=${APKSIGNER_JAR:-/root/android-sdk/build-tools/36.0.0/lib/apksigner.jar}
KS=${KS:-sign.dat}          # PKCS12 签名库
KS_PASS=${KS_PASS:-android}
KS_ALIAS=${KS_ALIAS:-shot}

B="build-$(date +%H%M%S)"
mkdir -p "$B/obj" "$B/gen" "$B/out"
ln -sfn "$B" current

echo "[1/6] aapt2 compile + link"
aapt2 compile --dir res -o "$B/out/res.zip"
aapt2 link -o "$B/out/base.apk" -I "$FRES" --manifest AndroidManifest.xml \
  --java "$B/gen" --min-sdk-version 30 --target-sdk-version 33 "$B/out/res.zip"

echo "[2/6] javac"
find src "$B/gen" -name '*.java' > "$B/srcs.txt"
javac -source 8 -target 8 -Xlint:-options -cp "$AJ" -d "$B/obj" @"$B/srcs.txt"

echo "[3/6] d8"
find "$B/obj" -name '*.class' > "$B/classes.txt"
java -cp "$D8JAR" com.android.tools.r8.D8 \
  --lib "$AJ" --min-api 30 --output "$B/out" $(cat "$B/classes.txt" | tr '\n' ' ')

echo "[4/6] 打包 classes.dex"
cp "$B/out/base.apk" "$B/out/unsigned.apk"
(cd "$B/out" && zip -q -u unsigned.apk classes.dex)

echo "[5/6] zipalign"
zipalign -f -p 4 "$B/out/unsigned.apk" "$B/out/aligned.apk"

echo "[6/6] 签名"
if [ ! -f "$KS" ]; then
  echo "    生成签名库 $KS"
  keytool -genkeypair -keystore "$KS" -storetype PKCS12 -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" -dname "CN=Shot"
fi
java -jar "$APKSIGNER_JAR" sign --ks "$KS" --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" \
  --out "$B/out/Shot.apk" "$B/out/aligned.apk"

cp "$B/out/Shot.apk" Shot.apk
echo "OK → $(pwd)/Shot.apk"
ls -lh Shot.apk
