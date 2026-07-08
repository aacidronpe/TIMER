const { app, BrowserWindow, Menu, ipcMain, dialog, Tray, nativeImage, systemPreferences, shell } = require("electron");
const path = require("path");
const fs = require("fs");

app.commandLine.appendSwitch("disable-gpu-sandbox");

function getDataDir() {
  let dir;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    dir = path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data");
  } else if (app.isPackaged) {
    dir = path.join(path.dirname(process.execPath), "data");
  } else {
    dir = app.getPath("userData");
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dataPath = path.join(getDataDir(), "timer-data.json");
const settingsPath = path.join(getDataDir(), "timer-settings.json");
const winStatePath = path.join(getDataDir(), "timer-winstate.json");

let mainWindow = null;
let statsWindow = null;
let tray = null;
let trackingInterval = null;
let timerInterval = null;
let activeWinLib = null;
let alwaysOnTopInterval = null;
let alwaysOnTopEnabled = false;
let iconCache = new Map();

let timerRunning = false;
let timerSeconds = 0;
let sessionStartTime = null;
let appUsageStats = new Map();
let completedSessions = [];

function loadData() {
  try {
    if (fs.existsSync(dataPath)) {
      const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      completedSessions = data.completedSessions || [];
    }
  } catch (e) {}
}
function saveData() {
  try { fs.writeFileSync(dataPath, JSON.stringify({ completedSessions })); } catch (e) {}
}
function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (e) {}
  return { theme: "dark", accentColor: "#888888", font: "'Segoe UI', sans-serif", fontSize: "42", scale: "100%" };
}
function saveSettings(s) { fs.writeFileSync(settingsPath, JSON.stringify(s)); }

function loadWinState() {
  try {
    if (fs.existsSync(winStatePath)) return JSON.parse(fs.readFileSync(winStatePath, "utf-8"));
  } catch (e) {}
  return {};
}
function saveWinState(key, bounds) {
  try {
    const state = loadWinState();
    state[key] = bounds;
    fs.writeFileSync(winStatePath, JSON.stringify(state));
  } catch (e) {}
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분`;
  return `${sec}초`;
}
function formatTimeRange(startMs, endMs) {
  const fmt = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; };
  return `${fmt(startMs)} - ${fmt(endMs)}`;
}
function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}. ${d.getMonth()+1}. ${d.getDate()}.`;
}

function getStatsData() {
  const cumulative = new Map();
  completedSessions.forEach(s => {
    s.apps.forEach(a => {
      if (!cumulative.has(a.name)) cumulative.set(a.name, { seconds: 0, path: a.path || null });
      cumulative.get(a.name).seconds += a.seconds;
      if (a.path && !cumulative.get(a.name).path) cumulative.get(a.name).path = a.path;
    });
  });
  appUsageStats.forEach((val, name) => {
    const sec = typeof val === "object" ? val.seconds : val;
    const p = typeof val === "object" ? val.path : null;
    if (!cumulative.has(name)) cumulative.set(name, { seconds: 0, path: p });
    cumulative.get(name).seconds += sec;
    if (p && !cumulative.get(name).path) cumulative.get(name).path = p;
  });
  const total = Array.from(cumulative.values()).reduce((s, v) => s + v.seconds, 0);
  const apps = Array.from(cumulative.entries())
    .map(([name, val]) => ({ name, seconds: val.seconds, path: val.path || null, percent: total > 0 ? Math.round((val.seconds / total) * 100) : 0 }))
    .sort((a, b) => b.seconds - a.seconds);
  const totalSessionTime = completedSessions.reduce((s, x) => s + x.duration, 0);
  const avgSession = completedSessions.length > 0 ? Math.round(totalSessionTime / completedSessions.length) : 0;
  return {
    apps, totalSeconds: total, sessionCount: completedSessions.length, avgSession, appCount: apps.length,
    recentSessions: completedSessions.slice().reverse().slice(0, 20).map(s => ({
      duration: s.duration, durationStr: formatTime(s.duration),
      dateStr: formatDate(s.startTime), timeRange: formatTimeRange(s.startTime, s.endTime),
    })),
  };
}
function sendStatsUpdate() {
  if (statsWindow && !statsWindow.isDestroyed()) statsWindow.webContents.send("stats-update", getStatsData());
}

let screenPermissionDialogShown = false;
function notifyScreenPermissionNeeded() {
  if (screenPermissionDialogShown) return;
  screenPermissionDialogShown = true;
  dialog.showMessageBox({
    type: "info",
    title: "권한 필요",
    message: "앱별 사용 시간을 기록하려면 '화면 기록' 권한이 필요해요.",
    detail: "시스템 설정 > 개인정보 보호 및 보안 > 화면 기록에서 TIMER를 켜주신 뒤, 앱을 완전히 종료했다가 다시 실행해주세요. (타이머 자체는 권한 없이도 정상 작동합니다.)",
    buttons: ["시스템 설정 열기", "닫기"],
    defaultId: 0,
  }).then((res) => {
    if (res.response === 0) {
      shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
  });
}

async function startTracking() {
  if (trackingInterval) return;
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus) {
    const status = systemPreferences.getMediaAccessStatus("screen");
    if (status !== "granted") {
      notifyScreenPermissionNeeded();
      return; // 권한 없으면 앱별 트래킹만 건너뛰고, 타이머 자체는 계속 진행
    }
  }
  if (!activeWinLib) {
    try { activeWinLib = (await import("active-win")).default; } catch (e) { return; }
  }
  let busy = false;
  trackingInterval = setInterval(async () => {
    if (!timerRunning || busy) return;
    busy = true;
    try {
      const winPromise = activeWinLib();
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 800));
      const win = await Promise.race([winPromise, timeout]);
      if (win && win.owner && win.owner.name) {
        const rawName = win.owner.name;
        const name = rawName.replace(/\.exe$/i, "");
        const skip = ["MyTimer", "TIMER", "Electron", "explorer", "Taskmgr", "Task Manager", "SearchHost", "SearchApp"];
        if (skip.some(s => name.toLowerCase().includes(s.toLowerCase()))) return;
        if (!appUsageStats.has(name)) appUsageStats.set(name, { seconds: 0, path: win.owner.path || null });
        appUsageStats.get(name).seconds += 1;
        sendStatsUpdate();
      }
    } catch (e) {} finally { busy = false; }
  }, 1000);
}
function stopTracking() {
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
}

function createMainWindow() {
  const state = loadWinState();
  const pos = state.main || {};
  const iconPath = require("path").join(__dirname, "icon.ico");
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 380, height: pos.height || 180,
    x: pos.x, y: pos.y,
    frame: false, resizable: false, thickFrame: false,
    transparent: true, backgroundColor: "#00000000",
    skipTaskbar: isMac ? true : false, alwaysOnTop: false, show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  mainWindow.loadFile("index.html");
  if (!isMac) {
    // Windows: 기존처럼 실행하면 바로 위젯이 뜸
    mainWindow.once("ready-to-show", () => mainWindow.show());
  }
  const saveMainBounds = () => { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) saveWinState("main", mainWindow.getBounds()); };
  mainWindow.on("moved", saveMainBounds);
  mainWindow.on("resized", saveMainBounds);

  if (isMac) {
    // 팝오버처럼: 다른 곳 클릭(포커스 아웃) 시 자동으로 숨김
    mainWindow.on("blur", () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    });
    // Escape 키로도 닫힘
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      }
    });
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: "통계 보기", click: () => showStatsWindow() },
    { label: "항상 위에 표시", type: "checkbox", checked: false, click: (item) => {
      alwaysOnTopEnabled = item.checked;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(item.checked, "pop-up-menu");
    }},
    { type: "separator" },
    { label: "데이터 초기화", click: () => {
      appUsageStats.clear(); completedSessions = []; saveData(); sendStatsUpdate();
    }},
    { type: "separator" },
    { label: "종료", click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  ipcMain.on("show-context-menu", () => contextMenu.popup({ window: mainWindow }));
  mainWindow.on("closed", () => { mainWindow = null; });
}


function showStatsWindow() {
  if (statsWindow && !statsWindow.isDestroyed()) { statsWindow.focus(); return; }
  const state = loadWinState();
  const pos = state.stats || {};
  const scale = mainWindow && !mainWindow.isDestroyed() ? (mainWindow._scale || 1) : 1;
  const baseW = 380, baseH = 580;
  const statsIconPath = require("path").join(__dirname, "icon.ico");
  statsWindow = new BrowserWindow({
    width: Math.round(baseW * scale), height: Math.round(baseH * scale),
    x: pos.x, y: pos.y,
    minWidth: 380, minHeight: 400,
    frame: false, resizable: true, thickFrame: false,
    transparent: true, backgroundColor: "#00000000",
    skipTaskbar: true, show: false,
    icon: fs.existsSync(statsIconPath) ? statsIconPath : undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
  });
  statsWindow.loadFile("stats.html");
  statsWindow.once("ready-to-show", () => {
    statsWindow.show();
    statsWindow._scale = scale;
    if (scale !== 1) statsWindow.webContents.setZoomFactor(scale);
    statsWindow.webContents.send("stats-update", getStatsData());
    if (alwaysOnTopEnabled) statsWindow.setAlwaysOnTop(true, "pop-up-menu");
  });
  const saveStatsBounds = () => { if (statsWindow && !statsWindow.isDestroyed()) saveWinState("stats", statsWindow.getBounds()); };
  statsWindow.on("moved", saveStatsBounds);
  statsWindow.on("resize", () => {
    if (statsWindow && !statsWindow.isDestroyed()) {
      const scale = mainWindow && !mainWindow.isDestroyed() ? (mainWindow._scale || 1) : 1;
      const [, h] = statsWindow.getSize();
      statsWindow.setSize(Math.round(380 * scale), h);
    }
  });
  statsWindow.on("resized", saveStatsBounds);
  statsWindow.on("closed", () => { statsWindow = null; });
}

ipcMain.handle("get-settings", () => loadSettings());
ipcMain.handle("save-settings", (_, s) => {
  saveSettings(s);
  [mainWindow, statsWindow].forEach(w => { if (w && !w.isDestroyed()) w.webContents.send("settings-update", s); });
});
ipcMain.handle("timer-start", async () => {
  timerRunning = true;
  if (!sessionStartTime) sessionStartTime = Date.now();
  await startTracking();
  timerInterval = setInterval(() => {
    timerSeconds++;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("timer-tick", timerSeconds);
    updateTrayTitle(timerSeconds);
  }, 1000);
  return timerSeconds;
});
ipcMain.handle("timer-stop", () => {
  timerRunning = false;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopTracking();
  updateTrayTitle(0);
  return timerSeconds;
});
ipcMain.handle("timer-complete", () => {
  timerRunning = false;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopTracking();
  updateTrayTitle(0);
  if (timerSeconds > 0) {
    completedSessions.push({ duration: timerSeconds, startTime: sessionStartTime || Date.now(), endTime: Date.now(), apps: Array.from(appUsageStats.entries()).map(([name, val]) => ({ name, seconds: typeof val === "object" ? val.seconds : val, path: typeof val === "object" ? val.path : null })) });
    if (completedSessions.length > 100) completedSessions = completedSessions.slice(-100);
    saveData();
  }
  appUsageStats.clear(); sessionStartTime = null;
  const sec = timerSeconds; timerSeconds = 0;
  sendStatsUpdate(); return sec;
});
ipcMain.handle("timer-reset", () => {
  timerRunning = false;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopTracking(); appUsageStats.clear(); sessionStartTime = null; timerSeconds = 0;
  updateTrayTitle(0);
  return 0;
});
ipcMain.handle("get-stats", () => getStatsData());
ipcMain.handle("clear-data", () => { appUsageStats.clear(); completedSessions = []; saveData(); sendStatsUpdate(); });
ipcMain.handle("set-always-on-top", (_, val) => {
  alwaysOnTopEnabled = val;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(val, "pop-up-menu");
  if (statsWindow && !statsWindow.isDestroyed()) statsWindow.setAlwaysOnTop(val, "pop-up-menu");
});
ipcMain.handle("show-stats", () => showStatsWindow());
ipcMain.handle("toggle-stats", () => {
  if (statsWindow && !statsWindow.isDestroyed()) statsWindow.close();
  else showStatsWindow();
});
ipcMain.handle("close-window", (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
ipcMain.handle("minimize-window", (e) => { BrowserWindow.fromWebContents(e.sender)?.minimize(); });
ipcMain.handle("resize-window", (_, height) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = mainWindow._scale || 1;
  const h = Math.min(2000, Math.max(50, Math.round(height * scale)));
  mainWindow._baseH = height;
mainWindow.setResizable(true);

mainWindow.setSize(
  Math.round(380 * scale),
  h
);

mainWindow.setResizable(false);
});


ipcMain.handle("scale-window", (_, scale) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow._baseH) mainWindow._baseH = 180;
  mainWindow._scale = scale;
  const w = Math.round(380 * scale);
  const h = Math.min(2000, Math.round(mainWindow._baseH * scale));
  mainWindow.setResizable(true);
  mainWindow.setSize(w, h);
  mainWindow.setResizable(false);
  mainWindow.webContents.setZoomFactor(scale);
  // 통계창도 같이 scale 적용
  if (statsWindow && !statsWindow.isDestroyed()) {
    const prevScale = statsWindow._scale || 1;
    const [curSW, curSH] = statsWindow.getSize();
    const baseSW = Math.round(curSW / prevScale);
    const baseSH = Math.round(curSH / prevScale);
    statsWindow._scale = scale;
    statsWindow.setSize(Math.round(baseSW * scale), Math.round(baseSH * scale));
    statsWindow.webContents.setZoomFactor(scale);
  }
});
ipcMain.handle("get-icon", async (_, exePath) => {
  if (!exePath) return null;
  if (iconCache.has(exePath)) return iconCache.get(exePath);
  try {
    const icon = await app.getFileIcon(exePath, { size: "large" });
    if (!icon.isEmpty()) {
      const buf = icon.toPNG();
      if (buf && buf.length > 1000) { const b64 = `data:image/png;base64,${buf.toString("base64")}`; iconCache.set(exePath, b64); return b64; }
    }
  } catch (e) {}
  iconCache.set(exePath, null); return null;
});

let mouseIdleTimer = null;
let mouseTrackingEnabled = false;
const MOUSE_IDLE_SECONDS = 5;

function startMouseTracking() {
  if (mouseTrackingEnabled) return;
  try {
    const { uIOhook } = require("uiohook-napi");
    mouseTrackingEnabled = true;

    const onMouseMove = () => {
      // 마우스 움직임 감지 → 타이머가 멈춰있으면 자동 START
      if (!timerRunning && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("auto-start");
      }
      // 아이들 타이머 리셋
      if (mouseIdleTimer) clearTimeout(mouseIdleTimer);
      mouseIdleTimer = setTimeout(() => {
        // N초 멈춤 → 자동 PAUSE
        if (timerRunning && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("auto-pause");
        }
      }, MOUSE_IDLE_SECONDS * 1000);
    };

    uIOhook.on("mousemove", onMouseMove);
    uIOhook.start();
  } catch (e) {
    console.error("uiohook-napi 로드 실패:", e);
  }
}

function stopMouseTracking() {
  if (!mouseTrackingEnabled) return;
  try {
    const { uIOhook } = require("uiohook-napi");
    uIOhook.stop();
    mouseTrackingEnabled = false;
  } catch (e) {}
  if (mouseIdleTimer) { clearTimeout(mouseIdleTimer); mouseIdleTimer = null; }
}

// 자동추적 켜기/끄기 IPC
ipcMain.handle("set-auto-track", (_, val) => {
  if (val) startMouseTracking();
  else stopMouseTracking();
});
function positionWindowUnderTray(win, trayRef) {
  if (!trayRef) return;
  const trayBounds = trayRef.getBounds();
  const winBounds = win.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);
  win.setPosition(x, y, false);
}

function toggleMainWindow() {
  const isMac = process.platform === "darwin";
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    if (isMac) {
      mainWindow.once("ready-to-show", () => {
        positionWindowUnderTray(mainWindow, tray);
        mainWindow.show();
        mainWindow.focus();
      });
    }
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    if (isMac) positionWindowUnderTray(mainWindow, tray);
    mainWindow.show();
    mainWindow.focus();
  }
}

function formatTraySeconds(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function updateTrayTitle(sec) {
  if (tray && process.platform === "darwin") {
    tray.setTitle(sec > 0 ? formatTraySeconds(sec) : "");
  }
}

function createTray() {
  // macOS 메뉴바는 작은 템플릿 아이콘을 권장 (trayTemplate.png, 22x22 흑백/투명 PNG)
  // Windows는 기존 icon.ico를 그대로 사용
  const trayIconPath = process.platform === "darwin"
    ? path.join(__dirname, "trayTemplate.png")
    : path.join(__dirname, "icon.ico");

  if (!fs.existsSync(trayIconPath)) {
    console.warn("트레이 아이콘 파일이 없어 메뉴바/트레이 아이콘을 건너뜁니다:", trayIconPath);
    return;
  }

  let image = nativeImage.createFromPath(trayIconPath);
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    image = image.resize({ width: 22, height: 22 });
    image.setTemplateImage(true); // 라이트/다크 메뉴바에 맞춰 자동으로 색이 반전됨
  }

  tray = new Tray(image);
  tray.setToolTip("TIMER");
  tray.on("click", () => toggleMainWindow());

  const trayMenu = Menu.buildFromTemplate([
    { label: "타이머 보이기/숨기기", click: () => toggleMainWindow() },
    { label: "통계 보기", click: () => showStatsWindow() },
    { type: "separator" },
    { label: "종료", click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
}

app.whenReady().then(() => {
  loadData();
  if (process.platform === "darwin" && app.dock) app.dock.hide(); // Dock 아이콘 제거
  createMainWindow();
  createTray();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
