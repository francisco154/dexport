/**
 * DexPort — Diccionario de apps populares
 * ════════════════════════════════════════════════════════════
 * El app drawer original mostraba etiquetas reales extraídas del APK
 * (vía el companion service). En el navegador las etiquetas de recursos
 * no son accesibles sin extraer el APK completo, así que usamos un
 * diccionario curado + etiquetas derivadas del package name.
 */

export interface AppEntry {
  packageName: string;
  label: string;
  system: boolean;
  /** v3: ícono real (base64 PNG) proveniente del companion original */
  icon?: string | null;
  /** v9: componente LAUNCHER exacto ("pkg/pkg.Activity") del DexPort Agent */
  component?: string;
}

const POPULAR_APPS: Record<string, string> = {
  "com.android.chrome": "Chrome",
  "com.chrome.beta": "Chrome Beta",
  "com.android.settings": "Settings",
  "com.android.camera": "Camera",
  "com.google.android.googlequicksearchbox": "Google",
  "com.google.android.apps.photos": "Photos",
  "com.google.android.apps.maps": "Maps",
  "com.google.android.gm": "Gmail",
  "com.google.android.youtube": "YouTube",
  "com.google.android.apps.youtube.music": "YT Music",
  "com.google.android.apps.messaging": "Messages",
  "com.google.android.dialer": "Phone",
  "com.google.android.contacts": "Contacts",
  "com.google.android.calculator": "Calculator",
  "com.google.android.calendar": "Calendar",
  "com.google.android.keep": "Keep",
  "com.google.android.apps.docs": "Drive",
  "com.google.android.apps.docs.editors.docs": "Docs",
  "com.google.android.apps.docs.editors.sheets": "Sheets",
  "com.google.android.apps.docs.editors.slides": "Slides",
  "com.google.android.deskclock": "Clock",
  "com.android.vending": "Play Store",
  "com.android.systemui": "System UI",
  "com.whatsapp": "WhatsApp",
  "com.facebook.katana": "Facebook",
  "com.facebook.orca": "Messenger",
  "com.instagram.android": "Instagram",
  "com.zhiliaoapp.musically": "TikTok",
  "com.ss.android.ugc.trill": "TikTok",
  "com.twitter.android": "X",
  "com.snapchat.android": "Snapchat",
  "com.spotify.music": "Spotify",
  "com.amazon.mp3": "Amazon Music",
  "com.netflix.mediaclient": "Netflix",
  "com.disney.disneyplus": "Disney+",
  "com.primevideo": "Prime Video",
  "com.hbo.hbomax": "Max",
  "com.valvesoftware.android.steam.community": "Steam",
  "com.discord": "Discord",
  "org.telegram.messenger": "Telegram",
  "org.thoughtcrime.securesms": "Signal",
  "com.skype.raider": "Skype",
  "com.zoom.videomeetings": "Zoom",
  "com.microsoft.teams": "Teams",
  "com.microsoft.office.outlook": "Outlook",
  "com.microsoft.office.word": "Word",
  "com.microsoft.office.excel": "Excel",
  "com.microsoft.office.powerpoint": "PowerPoint",
  "com.microsoft.emmx": "Edge",
  "com.brave.browser": "Brave",
  "com.opera.browser": "Opera",
  "org.mozilla.firefox": "Firefox",
  "com.termux": "Termux",
  "com.github.android": "GitHub",
  "com.reddit.frontpage": "Reddit",
  "com.pinterest": "Pinterest",
  "com.linkedin.android": "LinkedIn",
  "com ubercab": "Uber",
  "com.ubercab": "Uber",
  "com.airbnb.android": "Airbnb",
  "com.booking": "Booking",
  "com.shazam.android": "Shazam",
  "com.soundcloud.android": "SoundCloud",
  "com.tencent.mm": "WeChat",
  "com.viber.voip": "Viber",
  "com.android.gallery": "Gallery",
  "com.android.dialer": "Phone",
  "com.android.mms": "SMS",
  "com.android.deskclock": "Clock",
  "com.android.calculator2": "Calculator",
  "com.android.email": "Email",
  "com.android.browser": "Browser",
  "com.cyanogenmod.trebuchet": "Launcher",
  "com.android.launcher3": "Launcher",
  "com.sec.android.app.launcher": "Launcher",
  "com.miui.home": "Launcher",
  "com.google.android.apps.nbu.files": "Files",
  "com.android.storagemanager": "Storage",
  "com.android.cellbroadcastreceiver": "Emergency",
  "com.doom": "DOOM",
  "com.mojang.minecraftpe": "Minecraft",
  "com.tencent.tmgp.pubgmhd": "PUBG Mobile",
  "com.dts.freefireth": "Free Fire",
  "com.dts.freefiremax": "Free Fire MAX",
  "com.riotgames.league.wildrift": "Wild Rift",
  "com.supercell.clashofclans": "Clash of Clans",
  "com.supercell.clashroyale": "Clash Royale",
  "com.supercell.brawlstars": "Brawl Stars",
  "com.kiloo.subwaysurf": "Subway Surfers",
  "com.imangi.templerun2": "Temple Run 2",
  "com.ea.gp.fifamobile": "FC Mobile",
  "com.gameloft. [LoL]": "Gameloft",
  "com.mobile.legends": "Mobile Legends",
  "com.riotgames": "Riot",
  "com.tencent.tmgp.sgame": "Honor of Kings",
  "com.vng.games.ldlm": "LDLM",
  "com.roblox.client": "Roblox",
  "com.roblox": "Roblox",
  "io.supersonic": "Sonic",
  "org.videolan.vlc": "VLC",
  "com.mxtech.videoplayer.ad": "MX Player",
  "com.bilibili.app.in": "Bilibili",
  "tv.danmaku.bili": "Bilibili",
  "com.UCMobile.intl": "UC Browser",
  "com.UCMobile": "UC Browser",
  "in.mohalla.video": "Moj",
  "com.zego.demo": "Zego",
  "com.mycompanyville.smartapp": "Smart App",
  "jp.naver.line.android": "LINE",
  "com.kakao.talk": "KakaoTalk",
  "com.nhn.android.search": "Naver",
  "com.ebay.mobile": "eBay",
  "com.amazon.mShop.android.shopping": "Amazon",
  "com.alibaba.aliexpresshd": "AliExpress",
  "com.alibaba.android.rimet": "DingTalk",
  "com.taobao.taobao": "Taobao",
  "com.sina.weibo": "Weibo",
  "com.xunmeng.pinduoduo": "Temu",
  "com.pinterest.android": "Pinterest",
  "com.notion.android": "Notion",
  "com.todoist": "Todoist",
  "com.evernote": "Evernote",
  "com.dropbox.android": "Dropbox",
  "com Dropbox": "Dropbox",
  "com.adobe.reader": "Adobe Reader",
  "com.adobe.lrmobile": "Lightroom",
  "com.adobe.psmobile": "Photoshop",
  "com.canva.editor": "Canva",
  "com.capcut.editor": "CapCut",
  "com.duolingo": "Duolingo",
  "com.quizlet.quizletandroid": "Quizlet",
  "com.anki.android": "AnkiDroid",
  "com.musixmatch.android.lyrify": "Musixmatch",
  "com.shazam": "Shazam",
  "com.saavn.android": "JioSaavn",
  "com.gaana": "Gaana",
  "com.wynk.music": "Wynk",
  "com rzr.drawer.renderer": "RZR",
};

/** Iconos monocromáticos (lucide) para apps conocidas — fallback: letra */
const APP_ICONS: Record<string, string> = {
  "com.android.chrome": "globe",
  "com.google.android.youtube": "play",
  "com.whatsapp": "message-circle",
  "com.instagram.android": "camera",
  "com.spotify.music": "music",
  "com.google.android.apps.maps": "map",
  "com.android.settings": "settings",
  "com.google.android.gm": "mail",
  "com.google.android.apps.photos": "image",
  "com.google.android.apps.messaging": "message-square",
  "com.google.android.dialer": "phone",
  "com.google.android.contacts": "users",
  "com.google.android.calculator": "calculator",
  "com.google.android.calendar": "calendar",
  "com.google.android.deskclock": "clock",
  "com.android.vending": "shopping-bag",
  "com.termux": "terminal",
  "org.telegram.messenger": "send",
  "com.discord": "gamepad-2",
};

export function getAppIcon(packageName: string): string | null {
  return APP_ICONS[packageName] ?? null;
}

/** Etiqueta bonita para un package name. */
export function packageToLabel(packageName: string): string {
  const known = POPULAR_APPS[packageName];
  if (known) return known;
  const last = packageName.split(".").pop() ?? packageName;
  return last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Color determinista para el avatar de cada app. */
export function appColor(packageName: string): string {
  let hash = 0;
  for (let i = 0; i < packageName.length; i++) {
    hash = (hash * 31 + packageName.charCodeAt(i)) >>> 0;
  }
  const h = hash % 360;
  const sat = 42 + (hash % 18);
  const light = 38 + (hash % 14);
  return `hsl(${h} ${sat}% ${light}%)`;
}

/** Inicial visible para el avatar. */
export function appInitial(label: string): string {
  return (label?.[0] ?? "?").toUpperCase();
}

/**
 * Parsea `pm list packages` → AppEntry[]
 * (port del app drawer del original: secciones USER APPS / SYSTEM APPS)
 */
export function parsePackageList(
  output: string,
  systemOutput: string,
): { userApps: AppEntry[]; systemApps: AppEntry[] } {
  const user = new Set(
    output
      .split("\n")
      .map((l) => l.replace("package:", "").trim())
      .filter((p) => p.length > 2),
  );
  const system = new Set(
    systemOutput
      .split("\n")
      .map((l) => l.replace("package:", "").trim())
      .filter((p) => p.length > 2 && !user.has(p)),
  );

  const toEntry = (pkg: string, isSystem: boolean): AppEntry => ({
    packageName: pkg,
    label: packageToLabel(pkg),
    system: isSystem,
  });

  const userApps = [...user]
    .sort((a, b) => packageToLabel(a).localeCompare(packageToLabel(b)))
    .map((p) => toEntry(p, false));

  // Solo mostramos apps de sistema "lanzables" conocidas para no saturar
  const LAUNCHABLE_SYSTEM = new Set([
    "com.android.settings",
    "com.android.camera",
    "com.android.camera2",
    "com.android.dialer",
    "com.android.contacts",
    "com.android.deskclock",
    "com.android.calculator2",
    "com.android.gallery",
    "com.android.gallery3d",
    "com.android.email",
    "com.android.mms",
    "com.android.browser",
    "com.android.chrome",
    "com.google.android.dialer",
    "com.google.android.contacts",
    "com.google.android.apps.messaging",
    "com.google.android.deskclock",
    "com.google.android.calculator",
    "com.google.android.calendar",
    "com.google.android.apps.photos",
    "com.google.android.apps.maps",
    "com.google.android.gm",
    "com.google.android.apps.youtube.music",
    "com.google.android.apps.nbu.files",
    "com.google.android.googlequicksearchbox",
    "com.android.vending",
    "com.android.systemui",
    "com.miui.calculator",
    "com.miui.gallery",
    "com.miui.weather2",
    "com.miui.notes",
    "com.android.soundrecorder",
    "com.android.filemanager",
    "com.android.fmradio",
    "com.sec.android.app.sbrowser",
    "com.sec.android.app.camera",
    "com.samsung.android.dialer",
    "com.samsung.android.app.contacts",
    "com.samsung.android.messaging",
    "com.samsung.android.calendar",
    "com.coloros.gallery3d",
  ]);

  const systemApps = [...system]
    .filter((p) => LAUNCHABLE_SYSTEM.has(p))
    .sort((a, b) => packageToLabel(a).localeCompare(packageToLabel(b)))
    .map((p) => toEntry(p, true));

  return { userApps, systemApps };
}
