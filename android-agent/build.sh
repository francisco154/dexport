#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════
# DexPort Agent — build manual del APK (sin Gradle)
# aapt2 → javac → d8 → zip → zipalign → apksigner
# Requisitos: JDK 17+, Android build-tools 34, platform android-34.
#   ANDROID_SDK=/ruta/al/sdk ./build.sh
# ════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK:-/home/z/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
# JDK local (Temurin) si no hay JAVA_HOME ni javac en PATH
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  JAVA_BIN="$JAVA_HOME/bin/"
  export PATH="$JAVA_HOME/bin:$PATH"
elif command -v javac >/dev/null 2>&1; then
  JAVA_BIN=""
elif [ -x /home/z/jdk/bin/javac ]; then
  JAVA_BIN="/home/z/jdk/bin/"
  export PATH="/home/z/jdk/bin:$PATH"
else
  echo "ERROR: no se encontró javac (instala JDK 17+ o define JAVA_HOME)" >&2
  exit 1
fi

echo "── 1/7  keystore (una sola vez)"
if [ ! -f agent.keystore ]; then
  keytool -genkeypair -v \
    -keystore agent.keystore -alias agent \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass dexportagent -keypass dexportagent \
    -dname "CN=DexPort Agent, OU=DexPort, O=francisco154, C=AR" >/dev/null 2>&1
fi

echo "── 2/7  aapt2 compile (recursos)"
rm -rf build
mkdir -p build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip

echo "── 3/7  aapt2 link (manifest + R.java)"
"$BT/aapt2" link \
  -o build/base.apk \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  --java build/gen \
  -R build/res.zip \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code 3 --version-name "1.2" \
  --auto-add-overlay

echo "── 4/7  javac (Java 8 bytecode)"
find src build/gen -name "*.java" > build/sources.txt
"${JAVA_BIN}javac" --release 8 -nowarn \
  -classpath "$PLATFORM" \
  -d build/classes \
  @build/sources.txt

echo "── 5/7  d8 (dex)"
cd build/classes
"${JAVA_BIN}jar" cf ../classes.jar .
cd ../..
"$BT/d8" --release --lib "$PLATFORM" --min-api 26 \
  --output build/dex build/classes.jar

echo "── 6/7  empaquetar + zipalign"
cd build
cp base.apk unsigned.apk
cd dex && "${JAVA_BIN}jar" uf ../unsigned.apk classes.dex && cd ..
"$BT/zipalign" -f 4 unsigned.apk aligned.apk

echo "── 7/7  apksigner (firma v1+v2+v3)"
cd ..
"$BT/apksigner" sign \
  --ks agent.keystore \
  --ks-key-alias agent \
  --ks-pass pass:dexportagent --key-pass pass:dexportagent \
  --out dexport-agent.apk \
  build/aligned.apk

"$BT/apksigner" verify --print-certs dexport-agent.apk | head -4
ls -la dexport-agent.apk
echo "✓ APK listo: dexport-agent.apk"
