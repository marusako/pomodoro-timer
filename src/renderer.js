// レンダラープロセス: 画面の表示とボタン操作を担当する (ブラウザと同じ環境)
import { createState, durationMs, start, pause, reset, tick, skip, applySettings, formatTime, prepareFocus } from './timer.js';
import {
  toDateKey, parseDateKey, monthDays, eventsOn, datesWithEvents,
  makeEvent, nextEventId, addEvent, replaceEvent, removeEvent, parseEvents, MAX_EVENTS,
  skipEventOn, isOneOffOn, clearDate, weekDates, copyDateEvents,
} from './calendar.js';
import {
  MAX_SLOTS, makeSlot, nextSlotId, addSlot, replaceSlot, removeSlot, slotsOn, slotsOnDate, skipSlotsOn, parseTimetable,
  dayPlan, planTriggers, currentOrNextItem,
  copyDay, generateDay, generateDateEvents, replaceDay, REMINDER_MINUTES, scheduleReminders,
} from './schedule.js';
import { RANGES, parseSettings, effectiveVolume, resetSoundSettings } from './settings.js';
import { addCompletion, todayCount } from './stats.js';
import { periodDays, shiftAnchor, periodFocus, axisTicks } from './focus-stats.js';
import { TOTAL_ID, ongoingItems, focusStepMs, addFocusTime, addFocusCount, focusOf, dayFocus, forgetMissing, parseFocusLog, focusMinutes } from './focus-log.js';
import { INITIAL_UPDATE_STATE, nextUpdateState, isBannerVisible } from './update-status.js';
import { createWheelPicker } from './wheel-picker.js';
import { WALLPAPER_PRESETS } from './wallpapers.js';
import { mediaUrl } from './media-rules.js';
import { NOISE_TYPES } from './noise.js';
import { AMBIENT_TYPES } from './ambience.js';
// BGM の選択肢に並べる、アプリの中で作る音 (ノイズのあとに環境音)。保存の形はどちらも 'noise:<種類>'
const SYNTH_TYPES = [...NOISE_TYPES, ...AMBIENT_TYPES];
import { ALARM_SOUNDS } from './alarms.js';
import { SE_SOUNDS } from './se-sounds.js';
import { TIMER_FONTS, timerFont } from './fonts.js';
import { DEFAULT_PRESETS, MAX_CUSTOM_PRESETS, findMatchingPreset, addCustomPreset, removeCustomPreset, nextCustomNumber } from './presets.js';
import { escapeAction, backAction } from './fullscreen.js';
import { DATA_KEYS } from './data-file.js';
import { INITIAL_PLAYBACK, shouldPlayBgm, nextNoise, toggleNoise } from './bgm.js';
import {
  orderTracks, moveTrack, dropIndex, playQueue, nextInQueue, prevInQueue, prevAction, nextRepeatMode, formatTrackTime,
  ALL_TRACKS, MAX_PLAYLISTS, nextPlaylistNumber, addPlaylist, renamePlaylist, removePlaylist, setPlaylistTracks,
  toggleTrack, removeTrackEverywhere, playlistTracks,
} from './playlist.js';
import { BgmPlayer, playAlarm, playClick } from './sound.js';
import { LANGUAGES, translate, detectLanguage } from './i18n.js';

const CIRCUMFERENCE = 2 * Math.PI * 90;

const $ = (id) => document.getElementById(id);
const els = {
  wallpaper: $('wallpaper'),
  time: $('time'),
  label: $('label'),
  progress: $('progress'),
  toggle: $('toggle'),
  reset: $('reset'),
  skip: $('skip'),
  today: $('today'),
  cycle: $('cycle'),
  interval: $('interval'),
  openSettings: $('open-settings'),
  closeSettings: $('close-settings'),
  fullScreen: $('toggle-fullscreen'),
  cardOpacity: $('card-opacity'),
  cardOpacityOutput: document.querySelector('output[for="card-opacity"]'),
  cardOpacityHint: $('card-opacity-hint'),
  settings: $('settings'),
  alarmList: $('alarm-list'),
  seList: $('se-list'),
  bgmList: $('bgm-list'),
  wallpaperGrid: $('wallpaper-grid'),
  fontGrid: $('font-grid'),
  appVersion: $('app-version'),
  updateBanner: $('update-banner'),
  updateText: $('update-text'),
  updateProgress: $('update-progress'),
  updateAction: $('update-action'),
  updateLater: $('update-later'),
  language: $('language'),
  stats: $('stats'),
  showStats: $('show-stats'),
  nextEvent: $('next-event'),
  clock: $('clock'),
  calendar: $('calendar'),
  openCalendar: $('open-calendar'),
  timerSettings: $('timer-settings'),
  openTimer: $('open-timer'),
  closeTimer: $('close-timer'),
};

// --- 保存 ---
// アプリ (Electron) では、保存フォルダーの data.json に保存する (メインプロセスの data-store.js が読み書きする)。
// ブラウザーで開いたとき (window.dataStore がないとき) は、localStorage (ブラウザ内にデータを文字列で保存する仕組み) を使う
function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback; // 壊れたデータが入っていても起動できるようにする
  }
}

const fileStore = window.dataStore ? window.dataStore.loadAll() : null;
// まだ data.json がなければ (localStorage に保存していた v2.4 以前から更新した直後)、localStorage の中身を写す。
// localStorage は消さずに残す (前の版に戻したときや、何かあったときに戻せるように)
if (fileStore && !fileStore.exists) {
  for (const key of DATA_KEYS) {
    const value = loadLocal(key, undefined);
    if (value === undefined || value === null) continue;
    fileStore.data[key] = value;
    window.dataStore.set(key, value);
  }
}

function load(key, fallback) {
  if (!fileStore) return loadLocal(key, fallback);
  return fileStore.data[key] ?? fallback;
}
// 読み込んだデータで入れ替えたあとは、読み込み直すまで何も保存しない
// (閉じるときの保存 (pagehide) などで、入れ替えたデータを古いデータで上書きしないように)
let dataReplaced = false;
function save(key, value) {
  if (dataReplaced) return;
  if (!fileStore) {
    localStorage.setItem(key, JSON.stringify(value));
    return;
  }
  fileStore.data[key] = value;
  window.dataStore.set(key, value);
}

// 古い形式や壊れた値が保存されていても、parseSettings が既定値で補って範囲内に収める
let settings = parseSettings(load('settings', {}));
// 言語がまだ決まっていなければ (初回起動・以前の版から更新した直後)、Windows の言語から決めて保存する
if (settings.language === null) {
  settings = { ...settings, language: detectLanguage(navigator.language) };
  save('settings', settings);
}

// 画面の文字は、すべて翻訳表 (i18n.js) から選んでいる言語で取り出す
const t = (key, params) => translate(settings.language, key, params);
let stats = load('stats', null);
// カレンダーの予定 (calendar.js)。設定とは別に保存する
let events = parseEvents(load('events', []));
// 時間割 (schedule.js)。曜日ごとに毎週くり返すコマ
let timetable = parseTimetable(load('timetable', []));
// 外部カレンダーから取り込んだ予定 (calendar-feeds.js。読み取り専用で、ここには保存しない)。
// events は 1 回だけの予定の形 (カレンダーの予定と同じ関数で扱える)、allDay は終日の予定、feeds は各カレンダーの状態
let external = { feeds: [], events: [], allDay: [], available: false };
// 知らせ・次の予定・集中の記録・カレンダーの点に使う予定 (自分の予定 + 取り込んだ予定)
const planEvents = () => events.concat(external.events);
// 予定ごとの集中の記録 (focus-log.js)。3 か月より古い日は、読むときに忘れる
let focusLog = parseFocusLog(load('focusLog', {}), Date.now());
let state = createState(settings);

// 取り込んだ壁紙・BGM の一覧 ({ file: 保存名, name: 元のファイル名 })。window.media がない環境では空のまま
const media = { wallpapers: [], bgm: [] };
const bgm = new BgmPlayer((storedName) => mediaUrl('bgm', storedName), { onEnded: playNextTrack });

// --- BGM の再生 (bgm.js の決まりごと) ---
// 曲は ▶ / ⏸ で決め (playback.music)、ノイズは作業の始まり・休憩の始まり・▶ / ⏸ で決める (playback.noise)。
// アプリを閉じると忘れ、起動したときはどちらも止まっている
let playback = INITIAL_PLAYBACK;
// ノイズを作業・休憩の切り替わりに合わせるため、前回の表示のときのタイマーの状態を覚えておく
let lastTimerState = state;
// シャッフルで決めた再生順。曲の増減やシャッフル・プレイリストの切り替えがあるまで同じ順を使う (毎回変えると「前へ」で戻れないため)
let shuffledQueue = null;

// 再生バー (メイン画面の下) の部品
const player = {
  root: $('player'),
  seek: $('player-seek'),
  prev: $('player-prev'),
  toggle: $('player-toggle'),
  next: $('player-next'),
  title: $('player-title'),
  time: $('player-time'),
  repeat: $('player-repeat'),
  shuffle: $('player-shuffle'),
  openVolume: $('player-open-volume'),
  openList: $('player-open-list'),
  volumePopup: $('player-volume-popup'),
  volume: $('player-volume'),
  volumeOutput: $('player-volume-output'),
  listPopup: $('player-list-popup'),
  list: $('playlist'),
  listHint: $('playlist-hint'),
};
// 開いている小窓 ('list' / 'volume' / null)
let openPopup = null;
// 再生位置のつまみをつかんでいる間は、0.25 秒ごとの表示更新でつまみを動かさない
let seekDragging = false;

function currentTrack() {
  const [kind, file] = settings.bgm.split(':');
  return kind === 'import' ? file : null;
}

// 選んでいるプレイリストの曲 (シャッフルしていても、一覧にはこの順で出す)
function playlistOrder() {
  return playlistTracks(media.bgm.map((entry) => entry.file), settings.bgmOrder, settings.bgmPlaylists, settings.bgmPlaylist);
}

// 選んでいるカスタムのプレイリスト (「全曲」なら null)
function customPlaylist() {
  return settings.bgmPlaylists.find((p) => p.id === settings.bgmPlaylist) ?? null;
}

// 再生バーの ▶ / ⏸ で、今選んでいるもの (曲かノイズ) を流す・止める
function setPlaying(playing) {
  if (currentTrack() !== null) playback = { ...playback, music: playing };
  else if (playback.noise.on !== playing) playback = { ...playback, noise: toggleNoise(playback.noise) };
  render();
}

function isBgmPlaying() {
  return shouldPlayBgm(settings.bgm, playback);
}

function bgmQueue() {
  const order = playlistOrder();
  if (!settings.bgmShuffle) {
    shuffledQueue = null;
    return order;
  }
  const sameTracks = shuffledQueue?.length === order.length && order.every((file) => shuffledQueue.includes(file));
  if (!sameTracks) shuffledQueue = playQueue(order, true, currentTrack());
  return shuffledQueue;
}

// 取り込んだ曲が最後まで終わったとき
function playNextTrack() {
  const current = currentTrack();
  if (!current) return;
  const next = nextInQueue(bgmQueue(), current, settings.bgmRepeat, { auto: true });
  if (next === current) {
    bgm.restart();
  } else if (next === null) {
    // リピート「オフ」で最後の曲が終わったら止める (▶ を押すまで流さない)
    setPlaying(false);
  } else {
    updateSettings({ bgm: `import:${next}` });
  }
}

// 終わると次のモードが自動で始まっているので、何が始まったかを知らせる
function notify(finishedMode) {
  const started = t('notifyStarted', { mode: t(`modeText.${state.mode}`) });
  const body = finishedMode === 'work' ? t('notifyWorkDone', { started }) : started;
  showNotification(t('notifyTitle', { mode: t(`modeText.${finishedMode}`) }), body);
}

// アプリではメインプロセスが出し、押されたらアプリを前に出す (最小化していれば元に戻す)。
// Electron の外 (ブラウザーで開いたとき) は、ブラウザーの通知を出す
function showNotification(title, body) {
  if (window.notifier) window.notifier.show(title, body);
  else new Notification(title, { body, silent: true });
}

// --- 画面の更新 ---
function render() {
  const now = Date.now();
  const timerLike = renderTimer(now);

  // 隠していても回数の記録は続け、表示を戻したら正しい回数を出す
  els.stats.hidden = !settings.showStats;
  els.today.textContent = String(todayCount(stats, new Date()));
  els.cycle.textContent = String(state.completedWork % settings.longBreakInterval);
  els.interval.textContent = String(settings.longBreakInterval);

  // 作業が始まった・休憩が始まった・作業中にタイマーを止めた、をノイズに反映する
  if (timerLike !== lastTimerState) {
    playback = { ...playback, noise: nextNoise(playback.noise, lastTimerState, timerLike, durationMs('work', settings)) };
    lastTimerState = timerLike;
  }
  bgm.sync(isBgmPlaying());
  renderPlayer();
  renderNextEvent(now);
}

// タイマーの表示 (残り時間・モード・円)。ノイズの判断に使うタイマーの状態を返す
function renderTimer(now) {
  const time = formatTime(state.remainingMs);
  els.time.textContent = time;
  els.label.textContent = t(`mode.${state.mode}`);
  els.toggle.textContent = state.running ? t('pause') : t('start');
  document.body.dataset.mode = state.mode;
  document.title = `${time} - ${t(`mode.${state.mode}`)}`;

  for (const tab of document.querySelectorAll('[data-mode-tab]')) {
    tab.classList.toggle('active', tab.dataset.modeTab === state.mode);
  }

  // 実行中に設定を短く変えると 1 を超えうるので 0〜1 に収める
  const ratio = Math.min(1, Math.max(0, state.remainingMs / durationMs(state.mode, settings)));
  els.progress.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));
  // タイマーの下に、小さく今の時刻を出す
  els.clock.textContent = formatClock(now);
  return state;
}

// 集中の記録: 作業を数えている間、その日の合計と、今やっている予定に時間を足す。
// 保存は、数秒おき・作業を終えたとき・アプリを閉じるときにまとめて行う (毎回 localStorage に書かないように)
let lastFocusAt = Date.now();
let focusSavedAt = 0;
let focusDirty = false;

function saveFocusLog(now = Date.now()) {
  if (!focusDirty) return;
  focusLog = parseFocusLog(focusLog, now); // 3 か月より古い日を忘れる
  save('focusLog', focusLog);
  focusSavedAt = now;
  focusDirty = false;
}

// 前に数えたときから now までの作業の時間を、今やっている予定に足す。画面の更新ごとに加えて、
// タイマーの状態を変える直前 (スタート・一時停止・スキップなど) にも呼ぶ。
// そうすると、スタートを押す前の時間は数えず、一時停止・スキップの直前までの時間も漏れない
function recordFocusTime(now) {
  const ms = focusStepMs(state, lastFocusAt, now);
  if (ms > 0) {
    // その日の合計 (予定がなくても足す) と、今やっている予定
    focusLog = addFocusTime(focusLog, toDateKey(new Date(now)), [TOTAL_ID, ...ongoingItems(timetable, planEvents(), now)], ms);
    focusDirty = true;
  }
  lastFocusAt = now;
  if (now - focusSavedAt >= 5000) saveFocusLog(now);
}

function recordFocusCount(now) {
  focusLog = addFocusCount(focusLog, toDateKey(new Date(now)), [TOTAL_ID, ...ongoingItems(timetable, planEvents(), now)]);
  focusDirty = true;
  saveFocusLog(now);
  renderCalendar();
}

window.addEventListener('pagehide', () => saveFocusLog());

function update() {
  // 予定 (カレンダーの予定と毎週のコマ) の知らせ。開始時刻には、止まっていればタイマーを準備する
  const now = Date.now();
  checkEvents(now);
  recordFocusTime(now);
  const result = tick(state, now, settings);
  state = result.state;
  if (result.finished) {
    if (result.finishedMode === 'work') {
      stats = addCompletion(stats, new Date());
      save('stats', stats);
      recordFocusCount(now);
    }
    playAlarm(effectiveVolume(settings, 'alarmVolume'), settings.alarmSound);
    notify(result.finishedMode);
  }
  render();
}

// --- 操作 ---
// タイマーのボタン。状態を変える前に、押した瞬間までの作業の時間を記録する
function onControl(button, action) {
  button.addEventListener('click', () => {
    playClick(effectiveVolume(settings, 'seVolume'), settings.seSound);
    recordFocusTime(Date.now());
    action();
    render();
  });
}
onControl(els.toggle, () => {
  state = state.running ? pause(state, Date.now()) : start(state, Date.now());
});
onControl(els.reset, () => {
  state = reset(state, settings);
});
onControl(els.skip, () => {
  state = skip(state, settings, Date.now());
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const action = escapeAction({ settingsOpen: panelOpen(), popupOpen: openPopup !== null, fullScreen });
    if (action === 'closeSettings') closePanel();
    if (action === 'closePopup') {
      // 閉じた小窓を開いたボタンに戻る (キーボードで続けて操作できるように)
      const opener = openPopup === 'list' ? player.openList : player.openVolume;
      showPopup(null);
      opener.focus();
    }
    if (action === 'exitFullScreen') window.windowControls.exitFullScreen();
    return;
  }
  // Space で開始/停止 (設定・カレンダーを開いているときと、入力欄・選択欄・ボタンにいるときは除く)
  if (
    e.code === 'Space' &&
    !panelOpen() &&
    !(e.target instanceof HTMLInputElement) &&
    !(e.target instanceof HTMLSelectElement) &&
    !(e.target instanceof HTMLButtonElement)
  ) {
    e.preventDefault();
    els.toggle.click();
  }
});

// --- 設定 (変更はすぐに反映・保存する) ---
function updateSettings(patch) {
  const next = parseSettings({ ...settings, ...patch });
  // 始めたセッションの進み具合は消さず、まだ始めていないセッションだけ新しい時間にする
  state = applySettings(state, settings, next);
  settings = next;
  save('settings', settings);
  applyAppearance();
  applyLanguage();
  bgm.setSource(settings.bgm);
  bgm.setVolume(effectiveVolume(settings, 'bgmVolume'));
  renderVolumes();
  renderChoices();
  renderUpdate();
  render();
}

let appVersion = null;

// HTML に書いた文字 (data-i18n / data-i18n-aria) を、選んでいる言語に差し替える
function applyLanguage() {
  // lang 属性は、読み上げソフトやフォントの選び方に使われる
  document.documentElement.lang = settings.language;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const column of document.querySelectorAll('[data-label-key]')) {
    column.querySelector('.wheel')?.setAttribute('aria-label', t(column.dataset.labelKey));
  }
  els.language.value = settings.language;
  renderFullScreen();
  if (appVersion) els.appVersion.textContent = t('version', { version: appVersion });
}

function applyAppearance() {
  document.documentElement.dataset.theme = settings.theme;
  // タイマーの数字のフォント (style.css の .time が使う)
  const font = timerFont(settings.timerFont);
  document.documentElement.style.setProperty('--timer-font', font.family);
  document.documentElement.style.setProperty('--timer-weight', String(font.weight));
  document.documentElement.style.setProperty('--timer-size', String(font.size));

  const [kind, value] = settings.wallpaper.split(':');
  const isPreset = kind === 'preset' && WALLPAPER_PRESETS.some((p) => p.id === value);
  const isImport = kind === 'import';
  els.wallpaper.className = 'wallpaper';
  els.wallpaper.style.removeProperty('--wallpaper-image');
  if (isPreset) els.wallpaper.classList.add(`wp-${value}`);
  if (isImport) {
    els.wallpaper.classList.add('wp-import');
    els.wallpaper.style.setProperty('--wallpaper-image', `url("${mediaUrl('wallpapers', value)}")`);
  }
  const hasWallpaper = isPreset || isImport;
  document.documentElement.classList.toggle('has-wallpaper', hasWallpaper);
  document.documentElement.style.setProperty('--card-opacity', String(settings.cardOpacity));
  // 壁紙がないときはカードが出ないので、不透明度は変えられないようにして、理由の一言を出す
  els.cardOpacity.disabled = !hasWallpaper;
  els.cardOpacityHint.hidden = hasWallpaper;
  els.cardOpacity.value = String(settings.cardOpacity);
  els.cardOpacityOutput.textContent = `${settings.cardOpacity}%`;
}

// --- 設定パネルの開閉とタブ ---
// 設定パネルの中のタブだけ (再生リストの小窓の「音楽 / BGM」のタブは別に扱う)
const tabs = [...els.settings.querySelectorAll('[role="tab"]')];

function selectTab(name) {
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

function openSettings() {
  showPopup(null);
  els.calendar.hidden = true;
  els.timerSettings.hidden = true;
  els.settings.hidden = false;
  // 前に開いていたタブ。まだどれも選んでいなければ最初のタブ (Sound)
  selectTab(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')?.dataset.tab ?? tabs[0].dataset.tab);
  tabs.find((tab) => tab.tabIndex === 0).focus();
}

function closeSettings() {
  els.settings.hidden = true;
  els.openSettings.focus();
}

els.openSettings.addEventListener('click', openSettings);

// タイマーの設定 (プリセットと時間)。カレンダーと同じく、メイン画面の右上のボタンから開く
function openTimerSettings() {
  showPopup(null);
  els.settings.hidden = true;
  els.calendar.hidden = true;
  els.timerSettings.hidden = false;
  // 隠れていたあいだはホイールが描画されておらず、位置を合わせられないので、表示したときに合わせ直す
  wheels.forEach((picker) => picker.refresh());
  els.closeTimer.focus();
}

function closeTimerSettings() {
  els.timerSettings.hidden = true;
  closePresetForm();
  els.openTimer.focus();
}

els.openTimer.addEventListener('click', openTimerSettings);
els.closeTimer.addEventListener('click', closeTimerSettings);

// 設定・タイマーの設定・カレンダーのどれかが開いているか (Esc・戻る・Space で使う)。閉じるときは開いているものを閉じる
function panelOpen() {
  return !els.settings.hidden || !els.calendar.hidden || !els.timerSettings.hidden;
}

function closePanel() {
  if (!els.calendar.hidden) closeCalendar();
  else if (!els.timerSettings.hidden) closeTimerSettings();
  else closeSettings();
}

// --- 全画面表示 (F11 はメインプロセスが受け取り、切り替わったら onChange で知らせてくる) ---
let fullScreen = false;

function renderFullScreen() {
  els.fullScreen.dataset.fullscreen = String(fullScreen);
  const label = t(fullScreen ? 'exitFullScreen' : 'enterFullScreen');
  els.fullScreen.setAttribute('aria-label', label);
  els.fullScreen.title = label; // マウスを乗せたときに、キーでも切り替えられることを見せる
}

// クレジットの「GitHub」ボタン。開くページはメインプロセスが決めている (Electron の外ではボタンを出さない)
if (window.appLinks) {
  const button = $('open-repository');
  button.hidden = false;
  button.addEventListener('click', () => window.appLinks.openRepository());
}

// Electron の外 (ブラウザーで index.html を開いたとき) には windowControls がないので、ボタンを出さない
if (window.windowControls) {
  els.fullScreen.hidden = false;
  els.fullScreen.addEventListener('click', () => window.windowControls.toggleFullScreen());
  window.windowControls.onChange((value) => {
    fullScreen = value;
    renderFullScreen();
  });
  window.windowControls.isFullScreen().then((value) => {
    fullScreen = value;
    renderFullScreen();
  });
}
els.closeSettings.addEventListener('click', closeSettings);
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
  // 左右の矢印キーでタブを移動する (タブの標準的な操作方法)
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    selectTab(next.dataset.tab);
    next.focus();
  });
}

// --- タイマーの設定: ホイール ---
const wheels = [...document.querySelectorAll('[data-setting]')].map((column) => {
  const key = column.dataset.setting;
  const [min, max] = RANGES[key];
  const picker = createWheelPicker({
    min,
    max,
    value: settings[key],
    label: t(column.dataset.labelKey),
    onChange: (value) => updateSettings({ [key]: value }),
  });
  // タイトルと単位の間にホイールを入れる
  column.insertBefore(picker.element, column.querySelector('.wheel-unit'));
  picker.setValue(settings[key]);
  // どの設定項目のホイールかを覚えておく (プリセットで値をまとめて変えたときに、位置を合わせるため)
  return Object.assign(picker, { key });
});

// --- タイマーの設定: プリセット ---
const presetEls = {
  list: $('preset-list'),
  open: $('preset-save-open'),
  form: $('preset-form'),
  name: $('preset-name'),
  cancel: $('preset-cancel'),
  hint: $('preset-hint'),
};

function presetButton(preset, label, selected) {
  const wrap = document.createElement('div');
  wrap.className = 'preset';
  wrap.classList.toggle('checked', selected);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'preset-select';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(selected));
  const name = document.createElement('span');
  name.className = 'preset-name';
  name.textContent = label; // 自分で付けた名前も textContent で入れる (HTML として解釈させない)
  const detail = document.createElement('span');
  detail.className = 'preset-values';
  const v = preset.values;
  detail.textContent = t('presetValues', { work: v.workMinutes, short: v.shortBreakMinutes, long: v.longBreakMinutes, interval: v.longBreakInterval });
  button.append(name, detail);
  // 4 つの値をまとめて変え、ホイールの位置も合わせる (動いているセッションには、次から反映される)
  button.addEventListener('click', () => {
    updateSettings(preset.values);
    for (const picker of wheels) picker.setValue(settings[picker.key]);
  });
  wrap.append(button);
  return wrap;
}

function renderPresets() {
  const selectedId = findMatchingPreset(settings.customPresets, settings);
  const items = DEFAULT_PRESETS.map((p) => presetButton(p, t(`preset.${p.id}`), p.id === selectedId));
  for (const preset of settings.customPresets) {
    const item = presetButton(preset, preset.name, preset.id === selectedId);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('remove', { name: preset.name }));
    remove.addEventListener('click', () => {
      if (!confirm(t('confirmRemovePreset', { name: preset.name }))) return;
      updateSettings({ customPresets: removeCustomPreset(settings.customPresets, preset.id) });
    });
    item.append(remove);
    items.push(item);
  }
  presetEls.list.replaceChildren(...items);

  // 保存できないとき (上限に達した・同じ値のプリセットがすでにある) は、ボタンを押せなくして理由を出す
  const full = settings.customPresets.length >= MAX_CUSTOM_PRESETS;
  const exists = selectedId !== null;
  presetEls.open.disabled = full || exists;
  presetEls.hint.hidden = !(full || exists);
  presetEls.hint.textContent = full ? t('presetFull', { max: MAX_CUSTOM_PRESETS }) : exists ? t('presetExists') : '';
  if (presetEls.open.disabled) closePresetForm();
}

function openPresetForm() {
  presetEls.form.hidden = false;
  presetEls.open.hidden = true;
  presetEls.name.value = '';
  // 名前を入れなかったときに付く名前を、薄い文字で見せておく
  presetEls.name.placeholder = t('presetCustomName', { n: nextCustomNumber(settings.customPresets) });
  presetEls.name.focus();
}

function closePresetForm() {
  presetEls.form.hidden = true;
  presetEls.open.hidden = false;
}

presetEls.open.addEventListener('click', openPresetForm);
presetEls.cancel.addEventListener('click', closePresetForm);
presetEls.form.addEventListener('submit', (event) => {
  event.preventDefault(); // フォームの送信でページを読み込み直さないようにする
  const fallback = t('presetCustomName', { n: nextCustomNumber(settings.customPresets) });
  updateSettings({ customPresets: addCustomPreset(settings.customPresets, presetEls.name.value, settings, fallback) });
  closePresetForm();
});
// 入力中の Esc は、設定パネルを閉じずに入力欄だけを閉じる
presetEls.name.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  closePresetForm();
  presetEls.open.focus();
});

// --- Sound タブ: 音量 ---
const volumeSliders = [...document.querySelectorAll('[data-volume]')];

// スライダーの位置と、音量の数字 (0 のときは「消音」の文字) を表示する。
// 位置も合わせるのは、初期化ボタンなどスライダー以外で音量が変わることがあるため
function renderVolumes() {
  for (const slider of volumeSliders) {
    const value = settings[slider.dataset.volume];
    slider.value = String(value);
    document.querySelector(`output[for="${slider.id}"]`).textContent = value === 0 ? t('mute') : String(value);
  }
}

for (const slider of volumeSliders) {
  slider.addEventListener('input', () => updateSettings({ [slider.dataset.volume]: slider.value }));
}

const TESTS = {
  alarm: () => playAlarm(effectiveVolume(settings, 'alarmVolume'), settings.alarmSound),
  se: () => playClick(effectiveVolume(settings, 'seVolume'), settings.seSound),
  bgm: () => bgm.preview(),
};
// 初期化: 押し間違いで元の音量を失わないよう、確認してから戻す
$('reset-sound').addEventListener('click', () => {
  if (!confirm(t('confirmResetSound'))) return;
  updateSettings(resetSoundSettings(settings));
});

for (const button of document.querySelectorAll('[data-test]')) {
  button.addEventListener('click', TESTS[button.dataset.test]);
}

// --- Sound タブのアラーム・BGM の一覧と、Appearance タブの壁紙一覧 ---
// key は選んだときに書き換える設定の項目、id はその値
function choiceButton(label, key, id) {
  const wrap = document.createElement('div');
  wrap.className = 'choice';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'choice-select';
  button.setAttribute('role', 'radio');
  const checked = settings[key] === id;
  button.setAttribute('aria-checked', String(checked));
  wrap.classList.toggle('checked', checked);
  const name = document.createElement('span');
  name.className = 'choice-name';
  name.textContent = label; // ファイル名は textContent で入れる (HTML として解釈させない)
  button.append(name);
  button.addEventListener('click', () => updateSettings({ [key]: id }));
  wrap.append(button);
  return wrap;
}

function removeButton(kind, entry, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'remove-button';
  button.textContent = '×';
  button.setAttribute('aria-label', t('remove', { name: label }));
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    // 曲も壁紙も、確認せずに消す (取り込み元のファイルは残るので、また取り込める)
    await window.media.remove(kind, entry.file);
    media[kind] = media[kind].filter((m) => m.file !== entry.file);
    // 使っていたものを消したら「なし」に戻す。曲は、すべてのプレイリストからも除く
    const settingKey = kind === 'bgm' ? 'bgm' : 'wallpaper';
    const patch = kind === 'bgm' ? { bgmPlaylists: removeTrackEverywhere(settings.bgmPlaylists, entry.file) } : {};
    if (settings[settingKey] === `import:${entry.file}`) patch[settingKey] = 'none';
    updateSettings(patch);
  });
  return button;
}

function importButton(kind, className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.addEventListener('click', async () => {
    const { added, skipped } = await window.media.import(kind);
    if (skipped.length > 0) alert(t('importSkipped', { files: skipped.join('\n') }));
    if (added.length === 0) return;
    media[kind].push(...added);
    // 取り込んだら、最後に取り込んだものをすぐ使う
    const settingKey = kind === 'bgm' ? 'bgm' : 'wallpaper';
    updateSettings({ [settingKey]: `import:${added.at(-1).file}` });
    // 曲が多くて枠がスクロールしているときも、取り込んだ曲が見えるようにする
    if (kind === 'bgm') revealSelectedTrack();
  });
  label(button);
  return button;
}

// アラームは選んだらすぐ試聴する (音の違いは聞かないと分からないため)
function renderAlarmList() {
  els.alarmList.replaceChildren(...ALARM_SOUNDS.map((id) => {
    const item = choiceButton(t(`alarmSound.${id}`), 'alarmSound', id);
    item.querySelector('button').addEventListener('click', TESTS.alarm);
    return item;
  }));
}

// 効果音も、選んだらすぐ試聴する
function renderSeList() {
  els.seList.replaceChildren(...SE_SOUNDS.map((id) => {
    const item = choiceButton(t(`seSound.${id}`), 'seSound', id);
    item.querySelector('button').addEventListener('click', TESTS.se);
    return item;
  }));
}

function renderBgmList() {
  const items = [choiceButton(t('none'), 'bgm', 'none')];
  for (const type of SYNTH_TYPES) items.push(choiceButton(t(`noise.${type}`), 'bgm', `noise:${type}`));
  // 取り込んだ曲は、多くなったら枠の中でスクロールする (なし・ノイズ・取り込むボタンは、いつも見えるように枠の外に置く)
  if (media.bgm.length > 0) {
    // 設定を変えるたびに一覧を作り直すので、スクロールの位置を引き継ぐ (音量を動かしただけで先頭に戻らないように)
    const scrollTop = els.bgmList.querySelector('.bgm-tracks')?.scrollTop ?? 0;
    const tracks = document.createElement('div');
    tracks.className = 'bgm-tracks';
    for (const entry of media.bgm) {
      const item = choiceButton(entry.name, 'bgm', `import:${entry.file}`);
      item.append(removeButton('bgm', entry, entry.name));
      tracks.append(item);
    }
    items.push(tracks);
    queueMicrotask(() => { tracks.scrollTop = scrollTop; });
  }
  if (window.media) {
    items.push(importButton('bgm', 'secondary small import-button', (b) => { b.textContent = t('importEllipsis'); }));
  }
  els.bgmList.replaceChildren(...items);
}

// 選んでいる曲が枠の外にあれば、枠の真ん中あたりに見えるまでスクロールする (取り込んだ直後に使う)
function revealSelectedTrack() {
  const tracks = els.bgmList.querySelector('.bgm-tracks');
  const selected = tracks?.querySelector('.choice.checked');
  if (!tracks || !selected) return;
  const top = selected.offsetTop; // .bgm-tracks は position: relative なので、枠の中での位置
  if (top < tracks.scrollTop || top + selected.offsetHeight > tracks.scrollTop + tracks.clientHeight) {
    tracks.scrollTop = top - (tracks.clientHeight - selected.offsetHeight) / 2;
  }
}

function swatch(name, id, configure) {
  const wrap = document.createElement('div');
  wrap.className = 'swatch-wrap';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch';
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', String(settings.wallpaper === id));
  const label = document.createElement('span');
  label.className = 'swatch-name';
  label.textContent = name;
  button.append(label);
  button.addEventListener('click', () => updateSettings({ wallpaper: id }));
  configure?.(button);
  wrap.append(button);
  return wrap;
}

function renderWallpaperGrid() {
  const items = [swatch(t('none'), 'none', (b) => b.classList.add('wp-none'))];
  for (const preset of WALLPAPER_PRESETS) {
    items.push(swatch(preset.name, `preset:${preset.id}`, (b) => b.classList.add(`wp-${preset.id}`)));
  }
  for (const entry of media.wallpapers) {
    const item = swatch(entry.name, `import:${entry.file}`, (b) => {
      b.classList.add('wp-import');
      b.style.backgroundImage = `url("${mediaUrl('wallpapers', entry.file)}")`;
    });
    item.append(removeButton('wallpapers', entry, entry.name));
    items.push(item);
  }
  if (window.media) {
    const add = document.createElement('div');
    add.className = 'swatch-wrap';
    add.append(importButton('wallpapers', 'swatch add', (b) => {
      b.setAttribute('aria-label', t('importWallpaper'));
      b.textContent = '+';
      const name = document.createElement('span');
      name.className = 'swatch-name';
      name.textContent = t('import');
      b.append(name);
    }));
    items.push(add);
  }
  els.wallpaperGrid.replaceChildren(...items);
}

// 外観タブ: タイマーの数字のフォント。それぞれのフォントで見本の「25:00」を見せ、押したらすぐ変える
function renderFontGrid() {
  els.fontGrid.replaceChildren(...TIMER_FONTS.map((font) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'font-sample';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(settings.timerFont === font.id));
    const digits = document.createElement('span');
    digits.className = 'font-sample-digits';
    digits.textContent = '25:00';
    digits.style.fontFamily = font.family;
    digits.style.fontWeight = String(font.weight);
    digits.style.fontSize = `${26 * font.size}px`;
    digits.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'font-sample-name';
    name.textContent = t(`timerFont.${font.id}`);
    button.append(digits, name);
    button.addEventListener('click', () => updateSettings({ timerFont: font.id }));
    return button;
  }));
}

function renderChoices() {
  renderPresets();
  renderAlarmList();
  renderSeList();
  renderBgmList();
  renderFontGrid();
  renderWallpaperGrid();
  renderPlaylist();
}

els.cardOpacity.addEventListener('input', () => updateSettings({ cardOpacity: els.cardOpacity.value }));

for (const radio of document.querySelectorAll('input[name="theme"]')) {
  radio.checked = radio.value === settings.theme;
  radio.addEventListener('change', () => updateSettings({ theme: radio.value }));
}

// --- General タブ: 言語 (選択肢の名前は、それぞれの言語で書く) ---
els.language.replaceChildren(
  ...LANGUAGES.map(({ id, name }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    return option;
  }),
);
els.language.addEventListener('change', () => updateSettings({ language: els.language.value }));

els.showStats.checked = settings.showStats;
els.showStats.addEventListener('change', () => updateSettings({ showStats: els.showStats.checked }));

// データの書き出し・読み込み (アプリのときだけ)。読み込んだら、今のデータと入れ替えて画面を読み込み直す
// (読み込み直すと、各項目を parseSettings・parseEvents などが確かめ直す)
if (window.dataStore) {
  const status = $('data-status');
  const showStatus = (key) => {
    status.textContent = t(key);
    status.hidden = false;
  };
  $('data-tools').hidden = false;
  $('data-export').addEventListener('click', async () => {
    saveFocusLog();
    try {
      const { saved } = await window.dataStore.exportData();
      if (saved) showStatus('dataExported');
    } catch {
      showStatus('dataExportFailed');
    }
  });
  $('data-import').addEventListener('click', async () => {
    const result = await window.dataStore.importData();
    if (result.canceled) return;
    if (result.error) return showStatus('dataImportInvalid');
    if (!confirm(t('confirmDataImport'))) return;
    dataReplaced = true;
    if (await window.dataStore.replace(result.data)) {
      location.reload();
      return;
    }
    dataReplaced = false;
    showStatus('dataImportInvalid');
  });
}

// --- BGM の再生バー ---
function trackName() {
  const [kind, value] = settings.bgm.split(':');
  if (kind === 'noise') return t(`noise.${value}`);
  return media.bgm.find((entry) => entry.file === value)?.name ?? '';
}

// 0.25 秒ごとに呼ばれるので、文字と属性を書き換えるだけにする (一覧は作り直さない)
function renderPlayer() {
  const visible = settings.bgm !== 'none';
  player.root.hidden = !visible;
  document.documentElement.classList.toggle('has-player', visible);
  if (!visible) {
    if (openPopup) showPopup(null);
    return;
  }
  const track = currentTrack(); // ノイズのときは null
  player.title.textContent = trackName();
  player.title.title = player.title.textContent; // 長い曲名は省略されるので、マウスを乗せたら全部見せる

  // ▶ / ⏸ は、今流しているかで切り替える
  const playing = isBgmPlaying();
  player.toggle.dataset.state = playing ? 'pause' : 'play';
  player.toggle.setAttribute('aria-label', t(playing ? 'playerPause' : 'playerPlay'));
  player.prev.disabled = track === null;
  // リピート「オフ」の最後の曲では、次の曲がないので押せなくする
  player.next.disabled = track === null || nextInQueue(bgmQueue(), track, settings.bgmRepeat) === null;

  const position = track === null ? null : bgm.position();
  const duration = position?.duration ?? NaN;
  const canSeek = Number.isFinite(duration) && duration > 0;
  player.seek.disabled = !canSeek;
  if (!seekDragging) {
    player.seek.max = String(canSeek ? duration : 1);
    player.seek.value = String(canSeek ? position.current : 0);
  }
  const current = canSeek ? Number(player.seek.value) : 0;
  player.seek.style.setProperty('--seek', String(canSeek ? (current / duration) * 100 : 0));
  const timeText = `${formatTrackTime(current)} / ${formatTrackTime(duration)}`;
  player.seek.setAttribute('aria-valuetext', timeText);

  // 曲は経過時間。止まっているノイズは、作業が始まると流れることを知らせる
  player.time.textContent = track !== null ? timeText : playing ? '' : t('playerWaiting');

  player.repeat.dataset.repeat = settings.bgmRepeat;
  player.repeat.setAttribute('aria-label', t(`repeat.${settings.bgmRepeat}`));
  player.repeat.title = t(`repeat.${settings.bgmRepeat}`);
  player.shuffle.setAttribute('aria-pressed', String(settings.bgmShuffle));
  player.shuffle.title = t('shuffle');

  player.openVolume.dataset.muted = String(effectiveVolume(settings, 'bgmVolume') === 0);
  player.volume.value = String(settings.bgmVolume);
  player.volumeOutput.textContent = settings.bgmVolume === 0 ? t('mute') : String(settings.bgmVolume);

  // 再生リストの「今の曲」の印は、鳴っている間だけ動かす
  player.list.classList.toggle('playing', bgm.playing);
  noiseList.classList.toggle('playing', bgm.playing);
  renderMediaSession(canSeek ? { duration, position: current } : null);
}

// --- キーボードのメディアキー・Windows の再生操作 (Media Session) ---
// 曲名と再生状態を Windows に知らせ、▶⏸・前へ・次へのキーを再生バーのボタンと同じ動きにする
let mediaTitle = null;
function renderMediaSession(position) {
  if (!('mediaSession' in navigator)) return;
  const title = settings.bgm === 'none' ? '' : trackName();
  // 曲名は変わったときだけ渡す (0.25 秒ごとに作り直さない)
  if (title !== mediaTitle) {
    mediaTitle = title;
    navigator.mediaSession.metadata = title ? new MediaMetadata({ title }) : null;
  }
  navigator.mediaSession.playbackState = settings.bgm === 'none' ? 'none' : bgm.playing ? 'playing' : 'paused';
  try {
    navigator.mediaSession.setPositionState(position ? { ...position, playbackRate: 1 } : undefined);
  } catch {
    // 曲の長さを読み込む途中など、位置が長さを超えるときは送らない
  }
}

if ('mediaSession' in navigator) {
  // 押せないとき (ノイズ・リピート「オフ」の最後の曲) は、ボタンと同じく何もしない
  const pressPlayerButton = (button) => () => {
    if (!player.root.hidden && !button.disabled) button.click();
  };
  const handlers = {
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    previoustrack: pressPlayerButton(player.prev),
    nexttrack: pressPlayerButton(player.next),
    seekto: (details) => { bgm.seek(details.seekTime); renderPlayer(); },
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      // 対応していない操作は登録しない
    }
  }
}

function showPopup(name) {
  openPopup = name;
  // 閉じたら、次に開いたときは普通の一覧から (作りかけ・編集中のままにしない)
  if (name !== 'list') playlistMode = 'view';
  // 開いたときは、今選んでいるもの (曲かノイズか) のタブを見せる
  if (name === 'list') popupTab = settings.bgm.startsWith('noise:') ? 'noise' : 'music';
  player.listPopup.hidden = name !== 'list';
  player.volumePopup.hidden = name !== 'volume';
  player.openList.setAttribute('aria-expanded', String(name === 'list'));
  player.openVolume.setAttribute('aria-expanded', String(name === 'volume'));
  if (name === 'list') {
    renderPlaylist();
    // 今の曲が見える位置まで動かす
    player.list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }
}

// 曲を選んで流す (止めていても流す)。今の曲を選んだときは、続きから流す
function playTrack(file) {
  playback = { ...playback, music: true };
  if (file === currentTrack()) render();
  else updateSettings({ bgm: `import:${file}` });
}

// 前へ・次へ。同じ曲になるとき (1 曲だけの再生リストなど) は、最初から流し直す
function switchTrack(file) {
  if (file === null) return;
  if (file === currentTrack()) bgm.restart();
  playTrack(file);
}

const playlistEls = {
  choose: $('playlist-choose'),
  create: $('playlist-new'),
  edit: $('playlist-edit'),
  form: $('playlist-form'),
  name: $('playlist-name'),
  save: $('playlist-save'),
  cancel: $('playlist-cancel'),
  editActions: $('playlist-edit-actions'),
  remove: $('playlist-delete'),
  done: $('playlist-done'),
};
// 小窓の中の状態: 'view' (曲を選んで再生) / 'create' (名前を入れて新しく作る) / 'edit' (曲を選ぶ・名前を変える)
let playlistMode = 'view';
// 小窓のタブ: 'music' (取り込んだ曲・プレイリスト) / 'noise' (BGM のノイズ)
let popupTab = 'music';
const popupTabs = [...document.querySelectorAll('[data-popup-tab]')];
const noiseList = $('noise-list');

// 今の曲・ノイズの印 (3 本の棒)。鳴っている間だけ上下に動く (CSS の .playlist.playing)
function playingMeter() {
  const meter = document.createElement('span');
  meter.className = 'playlist-meter';
  meter.setAttribute('aria-hidden', 'true');
  meter.append(...[0, 1, 2].map(() => document.createElement('i')));
  return meter;
}

// BGM タブの 1 行。押すとそのノイズに切り替えて流す (プレイリストには入れられないので、チェックもドラッグもない)
function noiseItem(type, isCurrent) {
  const item = document.createElement('li');
  item.className = 'playlist-item';
  item.classList.toggle('current', isCurrent);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'playlist-select';
  button.textContent = t(`noise.${type}`);
  button.dataset.file = `noise:${type}`;
  if (isCurrent) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', () => playNoise(type));
  item.append(button);
  if (isCurrent) item.append(playingMeter());
  return item;
}

// ノイズを選んで流す (止めていても流す)
function playNoise(type) {
  playback = { ...playback, noise: { on: true, resume: false } };
  if (settings.bgm === `noise:${type}`) render();
  else updateSettings({ bgm: `noise:${type}` });
}

function selectPopupTab(name) {
  popupTab = name;
  if (name === 'noise') playlistMode = 'view'; // 作りかけ・編集中のプレイリストはやめる
  renderPlaylist();
}

for (const tab of popupTabs) {
  tab.addEventListener('click', () => selectPopupTab(tab.dataset.popupTab));
  // 左右の矢印キーでタブを移動する (設定パネルのタブと同じ)
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    const next = popupTabs[(popupTabs.indexOf(tab) + step + popupTabs.length) % popupTabs.length];
    selectPopupTab(next.dataset.popupTab);
    next.focus();
  });
}

function trackLabel(file) {
  return media.bgm.find((entry) => entry.file === file)?.name ?? file;
}

// 編集中の 1 行: チェックを付けた曲がプレイリストに入る
function playlistCheckItem(file, checked) {
  const item = document.createElement('li');
  item.className = 'playlist-item';
  const label = document.createElement('label');
  label.className = 'playlist-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.dataset.file = file;
  box.addEventListener('change', () => {
    const playlist = customPlaylist();
    if (!playlist) return;
    const tracks = toggleTrack(playlistOrder(), file, box.checked);
    updateSettings({ bgmPlaylists: setPlaylistTracks(settings.bgmPlaylists, playlist.id, tracks) });
  });
  const name = document.createElement('span');
  name.textContent = trackLabel(file); // ファイル名は textContent で入れる (HTML として解釈させない)
  name.title = name.textContent;
  label.append(box, name);
  item.append(label);
  return item;
}

function playlistItem(file, index, isCurrent) {
  const item = document.createElement('li');
  item.className = 'playlist-item';
  item.classList.toggle('current', isCurrent);
  item.draggable = true;
  item.dataset.index = String(index);
  const handle = document.createElement('span');
  handle.className = 'playlist-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.textContent = '⋮⋮';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'playlist-select';
  // ファイル名は textContent で入れる (HTML として解釈させない)
  button.textContent = trackLabel(file);
  button.title = button.textContent;
  button.dataset.file = file;
  if (isCurrent) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', () => playTrack(file));
  // キーボードでは Alt + ↑ / ↓ で 1 つずつ動かす (ドラッグができない人のため)
  button.addEventListener('keydown', (e) => {
    const step = e.altKey ? { ArrowUp: -1, ArrowDown: 1 }[e.key] : undefined;
    if (!step) return;
    e.preventDefault();
    if (reorderTrack(index, index + step)) player.list.children[index + step].querySelector('button').focus();
  });
  item.append(handle, button);
  if (isCurrent) item.append(playingMeter());
  return item;
}

// 一覧は、開いているときだけ作る (曲の増減・並べ替え・曲やプレイリストの切り替えで作り直す)
function renderPlaylist() {
  if (openPopup !== 'list') return;
  for (const tab of popupTabs) {
    const selected = tab.dataset.popupTab === popupTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  if (popupTab === 'noise') {
    const focusedNoise = noiseList.contains(document.activeElement) ? document.activeElement.dataset.file : undefined;
    noiseList.replaceChildren(...SYNTH_TYPES.map((type) => noiseItem(type, settings.bgm === `noise:${type}`)));
    if (focusedNoise) noiseList.querySelector(`[data-file="${CSS.escape(focusedNoise)}"]`)?.focus();
    return;
  }
  const playlist = customPlaylist();
  // 編集できるのは自分で作ったプレイリストだけ (「全曲」に切り替わったら編集をやめる)
  if (playlistMode === 'edit' && !playlist) playlistMode = 'view';

  // 上の段: 全曲 + 自分で作ったプレイリスト
  playlistEls.choose.replaceChildren(
    ...[{ id: ALL_TRACKS, name: t('playlistAll') }, ...settings.bgmPlaylists].map(({ id, name }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = name; // 自分で付けた名前も textContent で入れる
      return option;
    }),
  );
  playlistEls.choose.value = settings.bgmPlaylist;
  const full = settings.bgmPlaylists.length >= MAX_PLAYLISTS;
  playlistEls.choose.disabled = playlistMode !== 'view';
  playlistEls.create.disabled = full || playlistMode !== 'view';
  playlistEls.create.title = full ? t('playlistFull', { max: MAX_PLAYLISTS }) : t('playlistNew');
  playlistEls.edit.hidden = !playlist || playlistMode !== 'view';
  playlistEls.form.hidden = playlistMode === 'view';
  // 編集中の名前は、入力を終えたら (Enter・ほかを押す) すぐ変えるので、保存・キャンセルのボタンは要らない
  playlistEls.save.hidden = playlistMode === 'edit';
  playlistEls.cancel.hidden = playlistMode === 'edit';
  playlistEls.editActions.hidden = playlistMode !== 'edit';

  // 一覧を作り直してもキーボードの位置を失わないよう、選んでいた曲に戻す
  const focusedFile = player.list.contains(document.activeElement) ? document.activeElement.dataset.file : undefined;
  const order = playlistOrder();
  let hint;
  if (playlistMode === 'edit') {
    // 編集中は全曲を並べ、プレイリストに入っている曲にチェックを付ける
    const all = orderTracks(media.bgm.map((entry) => entry.file), settings.bgmOrder);
    player.list.replaceChildren(...all.map((file) => playlistCheckItem(file, order.includes(file))));
    hint = all.length === 0 ? 'playlistEmpty' : 'playlistEditHint';
  } else {
    const current = currentTrack();
    player.list.replaceChildren(...order.map((file, index) => playlistItem(file, index, file === current)));
    if (media.bgm.length === 0) hint = 'playlistEmpty';
    else if (order.length === 0) hint = 'playlistEmptyCustom';
    else hint = 'playlistHint';
  }
  player.list.hidden = player.list.children.length === 0;
  player.listHint.textContent = playlistMode === 'create' ? '' : t(hint);
  player.listHint.hidden = playlistMode === 'create';
  if (focusedFile) player.list.querySelector(`[data-file="${CSS.escape(focusedFile)}"]`)?.focus();
}

function setPlaylistMode(mode) {
  playlistMode = mode;
  if (mode === 'create') {
    playlistEls.name.value = '';
    // 名前を入れなかったときに付く名前を、薄い文字で見せておく
    playlistEls.name.placeholder = t('playlistCustomName', { n: nextPlaylistNumber(settings.bgmPlaylists) });
  }
  if (mode === 'edit') {
    playlistEls.name.value = customPlaylist()?.name ?? '';
    playlistEls.name.placeholder = '';
  }
  renderPlaylist();
  if (mode === 'view') playlistEls.choose.focus();
  else if (mode === 'create') playlistEls.name.focus();
}

// 並べ替えて保存する (「全曲」は bgmOrder、自分で作ったものはそのプレイリストの順)。動かせたら true
function reorderTrack(from, to) {
  const order = playlistOrder();
  if (from === to || to < 0 || to >= order.length) return false;
  const moved = moveTrack(order, from, to);
  const playlist = customPlaylist();
  if (playlist) updateSettings({ bgmPlaylists: setPlaylistTracks(settings.bgmPlaylists, playlist.id, moved) });
  else updateSettings({ bgmOrder: moved });
  return true;
}

// プレイリストを切り替える (流している曲はそのまま。次へ・曲の終わりから、選んだ一覧の曲に進む)
playlistEls.choose.addEventListener('change', () => {
  shuffledQueue = null;
  updateSettings({ bgmPlaylist: playlistEls.choose.value });
});
playlistEls.create.addEventListener('click', () => setPlaylistMode('create'));
playlistEls.edit.addEventListener('click', () => setPlaylistMode('edit'));
playlistEls.done.addEventListener('click', () => setPlaylistMode('view'));
playlistEls.cancel.addEventListener('click', () => setPlaylistMode('view'));
playlistEls.form.addEventListener('submit', (event) => {
  event.preventDefault(); // フォームの送信でページを読み込み直さないようにする
  if (playlistMode === 'edit') {
    playlistEls.name.blur(); // change で名前を変える
    return;
  }
  // 作ったら、そのプレイリストを選んで、すぐ曲を選べるように編集を始める
  const fallback = t('playlistCustomName', { n: nextPlaylistNumber(settings.bgmPlaylists) });
  const lists = addPlaylist(settings.bgmPlaylists, playlistEls.name.value, fallback);
  if (lists === settings.bgmPlaylists) return; // 上限
  shuffledQueue = null;
  playlistMode = 'edit';
  updateSettings({ bgmPlaylists: lists, bgmPlaylist: lists.at(-1).id });
  setPlaylistMode('edit');
});
// 編集中の名前の変更 (空にしたら元の名前に戻す)
playlistEls.name.addEventListener('change', () => {
  const playlist = customPlaylist();
  if (playlistMode !== 'edit' || !playlist) return;
  updateSettings({ bgmPlaylists: renamePlaylist(settings.bgmPlaylists, playlist.id, playlistEls.name.value) });
  playlistEls.name.value = customPlaylist().name;
});
// 名前の入力中の Esc は、小窓を閉じずに入力だけをやめる
playlistEls.name.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  if (playlistMode === 'create') setPlaylistMode('view');
  else playlistEls.name.value = customPlaylist()?.name ?? '';
});
playlistEls.remove.addEventListener('click', () => {
  const playlist = customPlaylist();
  if (!playlist || !confirm(t('confirmRemovePlaylist', { name: playlist.name }))) return;
  shuffledQueue = null;
  playlistMode = 'view';
  updateSettings({ bgmPlaylists: removePlaylist(settings.bgmPlaylists, playlist.id), bgmPlaylist: ALL_TRACKS });
  setPlaylistMode('view');
});

player.toggle.addEventListener('click', () => setPlaying(!isBgmPlaying()));
player.next.addEventListener('click', () => {
  switchTrack(nextInQueue(bgmQueue(), currentTrack(), settings.bgmRepeat));
});
player.prev.addEventListener('click', () => {
  const current = currentTrack();
  if (current === null) return;
  // 曲が少し進んでいたら、まずその曲の最初に戻る
  const restart = prevAction(bgm.position()?.current ?? 0) === 'restart';
  switchTrack(restart ? current : prevInQueue(bgmQueue(), current, settings.bgmRepeat));
});
player.repeat.addEventListener('click', () => updateSettings({ bgmRepeat: nextRepeatMode(settings.bgmRepeat) }));
player.shuffle.addEventListener('click', () => {
  shuffledQueue = null; // オンにするたびに、今の曲を先頭にして並べ直す
  updateSettings({ bgmShuffle: !settings.bgmShuffle });
});

player.seek.addEventListener('pointerdown', () => { seekDragging = true; });
window.addEventListener('pointerup', () => { seekDragging = false; });
player.seek.addEventListener('input', () => {
  bgm.seek(Number(player.seek.value));
  renderPlayer();
});

player.volume.addEventListener('input', () => updateSettings({ bgmVolume: player.volume.value }));
player.openVolume.addEventListener('click', () => showPopup(openPopup === 'volume' ? null : 'volume'));
player.openList.addEventListener('click', () => showPopup(openPopup === 'list' ? null : 'list'));
// 再生バーの外を押したら小窓を閉じる
document.addEventListener('pointerdown', (e) => {
  if (openPopup && !player.root.contains(e.target)) showPopup(null);
});

// --- 戻る: 何もないところのクリック・どこでも右クリックで、メイン画面に向かって 1 つ戻る (設定パネル → 小窓) ---
function goBack() {
  const action = backAction({ settingsOpen: panelOpen(), popupOpen: openPopup !== null });
  if (action === 'closeSettings') closePanel();
  if (action === 'closePopup') showPopup(null);
}

// 「何もないところ」: 画面の背景・タイマーのカードの余白・設定パネルの外側 (中身の列の外)。
// 設定の中の項目と項目のすき間は含めない (スライダーなどを少し外して押しただけで閉じないように)
function isEmptySpot(target) {
  return target === document.documentElement || target === document.body || target === els.wallpaper
    || target === els.settings || target === els.calendar || target === els.timerSettings || target.matches?.('.app');
}
// 押したところも何もないところだったときだけ戻る
// (スライダーをつかんで外で離すと、離した場所の「クリック」になるため)
let pressedOnEmpty = false;
document.addEventListener('pointerdown', (e) => {
  pressedOnEmpty = e.button === 0 && isEmptySpot(e.target);
});
document.addEventListener('click', (e) => {
  if (pressedOnEmpty && isEmptySpot(e.target)) goBack();
  pressedOnEmpty = false;
});
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  goBack();
});

// ドラッグで並べ替える。落とす場所 (曲の上半分なら前、下半分なら後ろ) に線を出す
let dragFrom = null;
function clearDropMarks() {
  for (const item of player.list.children) item.classList.remove('drop-before', 'drop-after', 'dragging');
}
player.list.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.playlist-item');
  if (!item) return;
  dragFrom = Number(item.dataset.index);
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});
player.list.addEventListener('dragover', (e) => {
  const item = e.target.closest('.playlist-item');
  if (dragFrom === null || !item) return;
  e.preventDefault(); // これで「ここに落とせる」ことになる
  const rect = item.getBoundingClientRect();
  const after = e.clientY > rect.top + rect.height / 2;
  for (const other of player.list.children) other.classList.remove('drop-before', 'drop-after');
  item.classList.add(after ? 'drop-after' : 'drop-before');
});
player.list.addEventListener('drop', (e) => {
  const item = e.target.closest('.playlist-item');
  if (dragFrom === null || !item) return;
  e.preventDefault();
  const from = dragFrom;
  dragFrom = null;
  if (!reorderTrack(from, dropIndex(from, Number(item.dataset.index), item.classList.contains('drop-after')))) clearDropMarks();
});
player.list.addEventListener('dragend', () => {
  dragFrom = null;
  clearDropMarks();
});

// --- カレンダー (calendar.js・schedule.js の決まりごと) ---
// 1 つの画面で、月のカレンダーから日を選び、その日の予定 (1 回だけの予定と、その曜日の毎週の時間割) をまとめて見る・編集する
const cal = {
  close: $('close-calendar'),
  prev: $('month-prev'),
  next: $('month-next'),
  today: $('month-today'),
  monthTitle: $('month-title'),
  grid: $('month-grid'),
  dayTitle: $('day-title'),
  dayFocus: $('day-focus'),
  add: $('event-add'),
  list: $('event-list'),
  empty: $('event-empty'),
  form: $('event-form'),
  repeat: $('event-repeat'),
  repeatWeekly: $('event-repeat-weekly'),
  repeatMonthly: $('event-repeat-monthly'),
  until: $('event-until'),
  title: $('event-title'),
  dateLabel: $('event-date-label'),
  date: $('event-date'),
  start: $('event-start'),
  end: $('event-end'),
  preset: $('event-preset'),
  error: $('event-error'),
  skip: $('event-skip'),
  remove: $('event-delete'),
  cancel: $('event-cancel'),
};
// 見ている月 (month は 0〜11)・選んでいる日・編集中のもの
// editing: null (フォームを閉じている) / { kind: 'event' | 'slot', id, on } (id が 'new' なら新しく作る。kind はフォームで選ぶ。
// on は、くり返す予定を開いた日 (「この日だけ休む」に使う))
let calMonth = { year: new Date().getFullYear(), month: new Date().getMonth() };
let selectedDate = toDateKey(new Date());
let editing = null;

// 選んでいる日の曜日 (0 = 日曜)。毎週の時間割の道具は、この曜日に効く
const selectedWeekday = () => parseDateKey(selectedDate).getDay();

// 消した予定・コマの集中の記録も忘れる
function forgetRemovedFocus() {
  const next = forgetMissing(focusLog, [...events, ...timetable].map((item) => item.id));
  if (next === focusLog) return;
  focusLog = next;
  save('focusLog', focusLog);
}

function saveEvents(next) {
  events = next;
  save('events', events);
  forgetRemovedFocus();
  renderCalendar();
  render();
}

function saveTimetable(next) {
  timetable = next;
  save('timetable', timetable);
  forgetRemovedFocus();
  renderCalendar();
  render();
}

// 予定に選んだプリセットの名前。消したプリセット・「今の設定のまま」は null
function eventPreset(id) {
  return DEFAULT_PRESETS.find((p) => p.id === id) ?? settings.customPresets.find((p) => p.id === id) ?? null;
}

function presetLabel(id) {
  const preset = eventPreset(id);
  if (!preset) return t('eventPresetCurrent');
  return DEFAULT_PRESETS.includes(preset) ? t(`preset.${preset.id}`) : preset.name;
}

// 日付・月・曜日の名前は、選んでいる言語の書き方で出す (例: 2026年10月 / October 2026)
const formatDate = (date, options) => new Intl.DateTimeFormat(settings.language, options).format(date);
// 曜日の名前 (2026-10-04 は日曜日なので、そこから数える)
const weekdayName = (weekday, style) => formatDate(new Date(2026, 9, 4 + weekday), { weekday: style });
// 曜日を並べるときは、時間割表と同じく月曜始まり
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function renderCalendar() {
  if (els.calendar.hidden) return;
  const { year, month } = calMonth;
  cal.monthTitle.textContent = formatDate(new Date(year, month, 1), { year: 'numeric', month: 'long' });

  // 曜日の行 (日曜始まり) と 6 週のマス。予定のある日 (1 回だけの予定か、毎週の時間割がある曜日) に点を付ける
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const cell = document.createElement('div');
    cell.className = 'weekday';
    cell.classList.toggle('sun', i === 0);
    cell.classList.toggle('sat', i === 6);
    cell.textContent = weekdayName(i, 'narrow');
    cell.setAttribute('aria-hidden', 'true');
    return cell;
  });
  const cells = monthDays(year, month);
  const marked = datesWithEvents(planEvents(), cells.map((cell) => cell.key));
  for (const item of external.allDay) marked.add(item.date);
  const todayKey = toDateKey(new Date());
  const days = cells.map(({ key, day, inMonth }) => {
    const date = parseDateKey(key);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-cell';
    button.classList.toggle('outside', !inMonth);
    button.classList.toggle('today', key === todayKey);
    button.classList.toggle('has-events', marked.has(key) || slotsOnDate(timetable, key).length > 0);
    button.setAttribute('aria-selected', String(key === selectedDate));
    button.setAttribute('aria-label', formatDate(date, { month: 'long', day: 'numeric', weekday: 'long' }));
    button.dataset.date = key;
    button.textContent = String(day);
    button.addEventListener('click', () => selectDate(key));
    return button;
  });
  cal.grid.replaceChildren(...weekdays, ...days);

  // 選んだ日の予定: カレンダーの予定 (くり返す予定はその日の回)、その曜日の時間割 (毎週)、外部カレンダーの予定を始まる順に。
  // 外部カレンダーの終日の予定は、いちばん上に並べる
  cal.dayTitle.textContent = formatDate(parseDateKey(selectedDate), { month: 'long', day: 'numeric', weekday: 'short' });
  // この日の予定で集中した合計 (記録がなければ出さない)
  const dayTotal = dayFocus(focusLog, selectedDate);
  cal.dayFocus.hidden = dayTotal.ms < 60000 && dayTotal.count === 0;
  cal.dayFocus.textContent = t('dayFocus', { minutes: focusMinutes(dayTotal.ms), count: dayTotal.count });
  const items = [
    ...eventsOn(events, selectedDate).map((e) => ({ start: e.start, end: e.end, el: eventItem(e) })),
    ...slotsOnDate(timetable, selectedDate).map((s) => ({ start: s.start, end: s.end, el: weeklyItem(s) })),
    ...eventsOn(external.events, selectedDate).map((e) => ({ start: e.start, end: e.end, el: externalItem(e) })),
    ...external.allDay.filter((e) => e.date === selectedDate).map((e) => ({ start: '', end: '', el: externalItem(e) })),
  ].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  cal.list.replaceChildren(...items.map((i) => i.el));
  const busy = editing !== null || !tools.generateForm.hidden || !tools.copyForm.hidden;
  cal.empty.hidden = items.length > 0 || editing !== null;
  cal.add.disabled = busy;
  renderTimetableTools(busy);
  renderFeeds();
  renderStats();
}

// 一覧の 1 行 (押すと編集、× で消す)。くり返すもの (毎週の時間割・毎日などの予定) には、くり返しの印 (tag) を付ける。
// 外部カレンダーの予定は読み取り専用なので、onOpen・onRemove を渡さない (押せない行にし、× を出さない)。
// 終日の予定は、時刻のかわりに timeText (「終日」) を出す
function listItem({ start, end, timeText, title, sub, tag: tagText, onOpen, onRemove }) {
  const item = document.createElement('li');
  item.className = 'event-item';
  item.classList.toggle('weekly', Boolean(tagText));
  item.classList.toggle('read-only', !onOpen);
  const open = document.createElement(onOpen ? 'button' : 'div');
  if (onOpen) open.type = 'button';
  open.className = 'event-open';
  const time = document.createElement('span');
  time.className = 'event-time';
  time.textContent = timeText ?? `${start} – ${end}`;
  const name = document.createElement('span');
  name.className = 'event-name';
  name.textContent = title; // 自分で付けた名前も textContent で入れる (HTML として解釈させない)
  if (tagText) {
    const tag = document.createElement('span');
    tag.className = 'event-tag';
    tag.textContent = tagText;
    name.append(tag);
  }
  open.append(time, name);
  if (sub) {
    const detail = document.createElement('span');
    detail.className = 'event-preset';
    detail.textContent = sub;
    open.append(detail);
  }
  item.append(open);
  if (onOpen) open.addEventListener('click', onOpen);
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('remove', { name: title }));
    remove.addEventListener('click', onRemove);
    item.append(remove);
  }
  return item;
}

// 外部カレンダーの予定 (読み取り専用)。カレンダーの名前の印を付ける。終日の予定は「終日」と出す
function externalItem(item) {
  return listItem({
    ...item,
    timeText: item.allDay ? t('eventAllDay') : undefined,
    sub: item.allDay ? null : subLine(null, item.id),
    tag: item.feedName,
  });
}

// 一覧の 2 行目: タイマー (選んだときだけ) と、その日の集中の記録 (あるときだけ)
function subLine(timerText, id) {
  const focus = focusOf(focusLog, selectedDate, id);
  const focusText = focus && (focus.ms >= 60000 || focus.count > 0)
    ? t('itemFocus', { minutes: focusMinutes(focus.ms), count: focus.count })
    : null;
  return [timerText, focusText].filter(Boolean).join('　') || null;
}

const REPEAT_TAGS = { daily: 'repeatTagDaily', weekdays: 'repeatTagWeekdays', monthly: 'repeatTagMonthly' };

// カレンダーの予定 (くり返す予定は、その日の回)。くり返す予定の × は、その日だけ休みにする (ほかの日は残る)
function eventItem(occurrence) {
  const original = events.find((e) => e.id === occurrence.id) ?? occurrence;
  const repeating = original.repeat !== 'none';
  return listItem({
    ...occurrence,
    // タイマーを選んでいない (今の設定のまま) ときは、タイマーの行を出さない
    sub: subLine(eventPreset(occurrence.preset) ? `${t('eventPreset')}: ${presetLabel(occurrence.preset)}` : null, occurrence.id),
    tag: repeating ? t(REPEAT_TAGS[original.repeat]) : null,
    onOpen: () => openEventForm({ kind: 'event', item: original, on: occurrence.date }),
    onRemove: () => (repeating ? skipEvent(original, occurrence.date) : deleteEvent(original)),
  });
}

// 毎週の時間割のコマ。× は、くり返す予定と同じく、その日だけ休みにする (すべての週から消すのはフォームの「すべての回を削除」)
function weeklyItem(slot) {
  return listItem({
    ...slot,
    tag: t('weeklyTag'),
    sub: subLine(null, slot.id),
    onOpen: () => openEventForm({ kind: 'slot', item: slot, on: selectedDate }),
    onRemove: () => skipSlot(slot, selectedDate),
  });
}

function selectDate(key) {
  selectedDate = key;
  const date = parseDateKey(key);
  calMonth = { year: date.getFullYear(), month: date.getMonth() };
  if (editing?.id === 'new') {
    cal.date.value = key; // 作っている途中なら、日付と「毎週〇曜日」「毎月〇日」も合わせる
    updateRepeatLabel();
  }
  // 曜日が変わると、まとめて作る・コピーの対象も変わるので閉じる
  closeToolForms();
  renderCalendar();
}

function moveMonth(step) {
  const first = new Date(calMonth.year, calMonth.month + step, 1);
  calMonth = { year: first.getFullYear(), month: first.getMonth() };
  renderCalendar();
}

// プリセットの選択肢: 今の設定のまま・デフォルト・自分で保存したもの
function renderPresetOptions(selectedId) {
  const options = [{ id: '', label: t('eventPresetCurrent') }];
  for (const p of DEFAULT_PRESETS) options.push({ id: p.id, label: t(`preset.${p.id}`) });
  for (const p of settings.customPresets) options.push({ id: p.id, label: p.name });
  cal.preset.replaceChildren(...options.map(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    return option;
  }));
  cal.preset.value = eventPreset(selectedId) ? selectedId : '';
}

// くり返し: 'none' (この日だけ) / 'daily' / 'weekdays' / 'monthly' (カレンダーの予定) / 'weekly' (毎週の時間割)
const repeatValue = () => cal.repeat.value;

// 「毎週〇曜日」「毎月〇日」の文字 (編集中のコマはその曜日、ほかは日付から)
function updateRepeatLabel() {
  const slot = editing?.kind === 'slot' && editing.id !== 'new' ? timetable.find((s) => s.id === editing.id) : null;
  const date = parseDateKey(cal.date.value) ?? parseDateKey(selectedDate);
  const weekday = slot ? slot.weekday : date.getDay();
  cal.repeatWeekly.textContent = t('eventRepeatWeekly', { weekday: weekdayName(weekday, 'long') });
  cal.repeatMonthly.textContent = t('eventRepeatMonthly', { day: date.getDate() });
}

// 毎週のときは、日付とタイマー (プリセット) を出さない。くり返す予定のときは、日付を「始まりの日」にして、終わりの日を出す
function applyRepeat() {
  const repeat = repeatValue();
  const repeating = repeat === 'daily' || repeat === 'weekdays' || repeat === 'monthly';
  cal.form.classList.toggle('weekly', repeat === 'weekly');
  cal.form.classList.toggle('repeating', repeating);
  cal.dateLabel.textContent = t(repeating ? 'eventStartDate' : 'eventDate');
  updateRepeatLabel();
  updateDeleteButtons();
}

// 消すボタン: くり返す予定・毎週のコマを開いた日があれば「この日だけ休む」も出し、削除は「すべての回を削除」にする
function updateDeleteButtons() {
  const original = editing?.kind === 'event' ? events.find((e) => e.id === editing.id) : null;
  const repeating = Boolean(original && original.repeat !== 'none') || (editing?.kind === 'slot' && editing.id !== 'new');
  cal.remove.hidden = !editing || editing.id === 'new';
  cal.remove.textContent = t(repeating ? 'eventDeleteAll' : 'eventDelete');
  cal.skip.hidden = !repeating || !editing.on;
}

cal.repeat.addEventListener('change', applyRepeat);
cal.date.addEventListener('input', updateRepeatLabel);

// 予定の追加と編集で、同じフォームを使う。target: { kind: 'event' | 'slot', item, on } (なしなら新しく作る)
function openEventForm(target = null) {
  closeToolForms();
  const item = target?.item ?? null;
  editing = { kind: target?.kind ?? 'event', id: item ? item.id : 'new', on: target?.on ?? null };
  // カレンダーの予定と毎週の時間割は別々にしまうので、作ったあとは行き来できない
  // (カレンダーの予定どうし (この日だけ・毎日・平日・毎月) は変えられる)
  cal.repeat.value = editing.kind === 'slot' ? 'weekly' : item?.repeat ?? 'none';
  for (const option of cal.repeat.options) {
    option.disabled = Boolean(item) && (option.value === 'weekly') !== (editing.kind === 'slot');
  }
  cal.until.value = item?.until ?? '';
  cal.title.value = item?.title ?? '';
  cal.title.placeholder = t('eventUntitled');
  cal.date.value = item?.date ?? selectedDate;
  // 新しい予定は、次のちょうどの時刻から 1 時間 (今日なら今の次の時、ほかの日なら 9:00)
  const nextHour = selectedDate === toDateKey(new Date()) ? Math.min(new Date().getHours() + 1, 22) : 9;
  cal.start.value = item?.start ?? `${String(nextHour).padStart(2, '0')}:00`;
  cal.end.value = item?.end ?? `${String(nextHour + 1).padStart(2, '0')}:00`;
  renderPresetOptions(item?.preset ?? null);
  cal.error.hidden = true;
  cal.form.hidden = false;
  applyRepeat();
  renderCalendar();
  cal.title.focus();
}

function closeEventFormQuietly() {
  editing = null;
  cal.form.hidden = true;
}

function closeEventForm() {
  closeEventFormQuietly();
  renderCalendar();
  cal.add.focus();
}

function showEventError(key) {
  cal.error.textContent = t(key, { max: repeatValue() === 'weekly' ? MAX_SLOTS : MAX_EVENTS });
  cal.error.hidden = false;
}

const ERROR_MESSAGES = {
  endBeforeStart: 'eventErrorEndBeforeStart', invalidTime: 'eventErrorInvalidTime', invalidDate: 'eventErrorInvalidDate',
  invalidWeekday: 'eventErrorInvalidDate', untilBeforeDate: 'eventErrorUntilBeforeDate',
};

cal.form.addEventListener('submit', (e) => {
  e.preventDefault(); // フォームの送信でページを読み込み直さないようにする
  const isNew = editing.id === 'new';
  const input = { title: cal.title.value, start: cal.start.value, end: cal.end.value };

  if (repeatValue() === 'weekly') {
    if (isNew && timetable.length >= MAX_SLOTS) return showEventError('slotErrorFull');
    const existing = timetable.find((s) => s.id === editing.id);
    const weekday = existing ? existing.weekday : (parseDateKey(cal.date.value) ?? parseDateKey(selectedDate)).getDay();
    // 休みにした日は、編集しても残す
    const made = makeSlot({ ...input, weekday, skips: existing?.skips ?? [] }, isNew ? nextSlotId(timetable) : editing.id, t('eventUntitled'));
    if (made.error) return showEventError(ERROR_MESSAGES[made.error]);
    closeEventFormQuietly();
    saveTimetable(isNew ? addSlot(timetable, made.slot) : replaceSlot(timetable, made.slot));
  } else {
    if (isNew && events.length >= MAX_EVENTS) return showEventError('eventErrorFull');
    // 休みにした日は、編集しても残す (くり返しの範囲から外れた日は makeEvent が捨てる)
    const skips = events.find((ev) => ev.id === editing.id)?.skips ?? [];
    const made = makeEvent(
      { ...input, date: cal.date.value, preset: cal.preset.value, repeat: repeatValue(), until: cal.until.value || null, skips },
      isNew ? nextEventId(events) : editing.id,
      t('eventUntitled'),
    );
    if (made.error) return showEventError(ERROR_MESSAGES[made.error]);
    closeEventFormQuietly();
    const saved = isNew ? addEvent(events, made.event) : replaceEvent(events, made.event);
    // 選んでいる日に予定がなくなったら、保存した予定の (始まりの) 日を選んで見せる (どこに入ったか分かるように)
    if (!eventsOn(saved, selectedDate).some((ev) => ev.id === made.event.id)) {
      selectedDate = made.event.date;
      const date = parseDateKey(selectedDate);
      calMonth = { year: date.getFullYear(), month: date.getMonth() };
    }
    saveEvents(saved);
  }
  cal.add.focus();
});

// 予定・コマは、確認せずに消す
function deleteEvent(event) {
  if (editing?.id === event.id) closeEventFormQuietly();
  saveEvents(removeEvent(events, event.id));
}

// くり返す予定の、その日の回だけを休みにする (ほかの日は残る)
function skipEvent(event, key) {
  if (editing?.id === event.id) closeEventFormQuietly();
  saveEvents(skipEventOn(events, event.id, key));
}

function skipSlot(slot, key) {
  if (editing?.id === slot.id) closeEventFormQuietly();
  saveTimetable(skipSlotsOn(timetable, key, slot.id));
}

function deleteSlot(slot) {
  if (editing?.id === slot.id) closeEventFormQuietly();
  saveTimetable(removeSlot(timetable, slot.id));
}

cal.skip.addEventListener('click', () => {
  if (!editing?.on) return;
  const { kind, id, on } = editing;
  if (kind === 'slot') {
    const slot = timetable.find((s) => s.id === id);
    if (slot) skipSlot(slot, on);
  } else {
    const event = events.find((ev) => ev.id === id);
    if (event) skipEvent(event, on);
  }
  cal.add.focus();
});

cal.remove.addEventListener('click', () => {
  if (editing?.kind === 'slot') {
    const slot = timetable.find((s) => s.id === editing.id);
    if (slot) deleteSlot(slot);
  } else {
    const event = events.find((ev) => ev.id === editing?.id);
    if (event) deleteEvent(event);
  }
});
cal.cancel.addEventListener('click', closeEventForm);
// フォームの中の Esc は、カレンダーを閉じずにフォームだけを閉じる
cal.form.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeEventForm();
});
cal.add.addEventListener('click', () => openEventForm());
cal.prev.addEventListener('click', () => moveMonth(-1));
cal.next.addEventListener('click', () => moveMonth(1));
cal.today.addEventListener('click', () => selectDate(toDateKey(new Date())));
cal.close.addEventListener('click', closeCalendar);
// 矢印キーで日を動かす (← → は 1 日、↑ ↓ は 1 週)
cal.grid.addEventListener('keydown', (e) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (!step || !e.target.dataset.date) return;
  e.preventDefault();
  const date = parseDateKey(e.target.dataset.date);
  selectDate(toDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + step)));
  cal.grid.querySelector(`[data-date="${selectedDate}"]`)?.focus();
});

function openCalendar(dateKey = toDateKey(new Date())) {
  showPopup(null);
  els.settings.hidden = true;
  els.timerSettings.hidden = true;
  els.calendar.hidden = false;
  closeEventFormQuietly();
  selectCalendarTab('calendar');
  selectDate(dateKey);
  cal.grid.querySelector(`[data-date="${selectedDate}"]`)?.focus();
}

// --- カレンダーと記録の切り替え ---
const calendarTabs = [...els.calendar.querySelectorAll('[data-cal-tab]')];

function selectCalendarTab(name) {
  for (const tab of calendarTabs) {
    const selected = tab.dataset.calTab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
  }
  if (name === 'stats') {
    // 開くたびに今週 (今月) から見せる
    statsView.anchor = toDateKey(new Date());
    statsView.selected = null;
    renderStats();
  }
}

for (const tab of calendarTabs) {
  tab.addEventListener('click', () => selectCalendarTab(tab.dataset.calTab));
  // 左右の矢印キーでタブを移動する (設定のタブと同じ操作)
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (!step) return;
    const next = calendarTabs[(calendarTabs.indexOf(tab) + step + calendarTabs.length) % calendarTabs.length];
    selectCalendarTab(next.dataset.calTab);
    next.focus();
  });
}

// --- 記録: 週・月の集中の合計、日ごとの棒グラフ、前の週・月との差 ---
const statsView = {
  kind: 'week', // 'week' / 'month'
  anchor: toDateKey(new Date()), // 見ている期間の中の 1 日
  selected: null, // 押した棒の日 (下に値を出す)
  pane: $('cal-pane-stats'),
  title: $('stats-title'),
  prev: $('stats-prev'),
  next: $('stats-next'),
  current: $('stats-current'),
  total: $('stats-total'),
  count: $('stats-count'),
  diff: $('stats-diff'),
  axis: $('stats-axis'),
  plot: $('stats-plot'),
  detail: $('stats-detail'),
};

// 時間の表し方: 1 時間未満は「40 分」、それ以上は「1 時間 5 分」(分は切り捨て)
function formatDuration(ms) {
  const minutes = focusMinutes(ms);
  if (minutes < 60) return t('durationMinutes', { minutes });
  return t('durationHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

function statsDayText(day) {
  return t('statsDay', {
    date: formatDate(parseDateKey(day.key), { month: 'long', day: 'numeric', weekday: 'short' }),
    duration: formatDuration(day.ms),
    count: day.count,
  });
}

function renderStats() {
  if (els.calendar.hidden || statsView.pane.hidden) return;
  const week = statsView.kind === 'week';
  const days = periodDays(statsView.kind, statsView.anchor);
  const result = periodFocus(focusLog, days);
  const before = periodFocus(focusLog, periodDays(statsView.kind, shiftAnchor(statsView.kind, statsView.anchor, -1)));

  const first = parseDateKey(days[0]);
  const last = parseDateKey(days.at(-1));
  statsView.title.textContent = week
    ? `${formatDate(first, { month: 'short', day: 'numeric' })} – ${formatDate(last, { month: 'short', day: 'numeric' })}`
    : formatDate(first, { year: 'numeric', month: 'long' });
  statsView.prev.setAttribute('aria-label', t(week ? 'weekPrev' : 'monthPrev'));
  statsView.next.setAttribute('aria-label', t(week ? 'weekNext' : 'monthNext'));
  statsView.current.textContent = t(week ? 'statsThisWeek' : 'statsThisMonth');
  const todayKey = toDateKey(new Date());
  statsView.current.disabled = days.includes(todayKey);
  statsView.next.disabled = days.at(-1) >= todayKey; // まだ来ていない期間には進まない

  statsView.total.textContent = formatDuration(result.ms);
  statsView.count.textContent = t('statsCount', { count: result.count });
  // 前の期間との差 (分で比べる)。符号を付けて、増えたか減ったかを文字でも分かるようにする
  const diffMinutes = focusMinutes(result.ms) - focusMinutes(before.ms);
  const sign = diffMinutes > 0 ? '+' : diffMinutes < 0 ? '−' : '±';
  statsView.diff.textContent = t(week ? 'statsDiffWeek' : 'statsDiffMonth', { diff: `${sign}${formatDuration(Math.abs(diffMinutes) * 60000)}` });

  // 縦軸: 0 から切りのいい間隔の目盛り。棒の高さは、一番上の目盛りを 100% にする
  const ticks = axisTicks(Math.max(...result.days.map((d) => d.ms)));
  const top = ticks.at(-1) * 60000;
  statsView.axis.replaceChildren(...ticks.map((minutes) => {
    const label = document.createElement('span');
    label.style.setProperty('--p', `${(minutes / ticks.at(-1)) * 100}%`);
    label.textContent = minutes > 0 && minutes % 60 === 0 ? t('axisHours', { hours: minutes / 60 }) : t('axisMinutes', { minutes });
    return label;
  }));
  const gridlines = ticks.map((minutes) => {
    const line = document.createElement('span');
    line.className = 'stats-gridline';
    line.style.setProperty('--p-num', String(minutes / ticks.at(-1)));
    return line;
  });

  // 日ごとの棒
  const bars = result.days.map((day) => {
    const date = parseDateKey(day.key);
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'stats-bar';
    bar.setAttribute('role', 'listitem');
    bar.classList.toggle('zero', day.ms === 0);
    bar.classList.toggle('today', day.key === todayKey);
    bar.setAttribute('aria-pressed', String(day.key === statsView.selected));
    bar.setAttribute('aria-label', statsDayText(day));
    bar.title = statsDayText(day);
    const fill = document.createElement('span');
    fill.className = 'fill';
    fill.style.setProperty('--h', `${Math.min(day.ms / top, 1) * 100}%`);
    const label = document.createElement('span');
    label.className = 'label';
    label.setAttribute('aria-hidden', 'true');
    // 週は曜日、月は 1 日と 5 の倍数の日だけ (31 本並ぶと数字が重なるため)
    const n = date.getDate();
    label.textContent = week ? formatDate(date, { weekday: 'narrow' }) : n === 1 || n % 5 === 0 ? String(n) : '';
    bar.append(fill, label);
    bar.addEventListener('click', () => {
      statsView.selected = statsView.selected === day.key ? null : day.key;
      renderStats();
    });
    bar.addEventListener('pointerenter', () => { statsView.detail.textContent = statsDayText(day); });
    bar.addEventListener('pointerleave', () => renderStatsDetail(result));
    return bar;
  });
  statsView.plot.replaceChildren(...gridlines, ...bars);
  renderStatsDetail(result);
}

// 棒の下の 1 行: 押した日 (なければ、期間の中の今日) の値
function renderStatsDetail(result) {
  const key = statsView.selected ?? toDateKey(new Date());
  const day = result.days.find((d) => d.key === key);
  statsView.detail.textContent = day ? statsDayText(day) : '';
}

for (const input of document.querySelectorAll('input[name="stats-period"]')) {
  input.addEventListener('change', () => {
    statsView.kind = input.value;
    statsView.selected = null;
    renderStats();
  });
}
statsView.prev.addEventListener('click', () => {
  statsView.anchor = shiftAnchor(statsView.kind, statsView.anchor, -1);
  statsView.selected = null;
  renderStats();
});
statsView.next.addEventListener('click', () => {
  statsView.anchor = shiftAnchor(statsView.kind, statsView.anchor, 1);
  statsView.selected = null;
  renderStats();
});
statsView.current.addEventListener('click', () => {
  statsView.anchor = toDateKey(new Date());
  statsView.selected = null;
  renderStats();
});

function closeCalendar() {
  els.calendar.hidden = true;
  closeEventFormQuietly();
  closeToolForms();
  els.openCalendar.focus();
}

els.openCalendar.addEventListener('click', () => openCalendar());
els.nextEvent.addEventListener('click', () => openCalendar());

// メイン画面の今日の予定の 1 行 (今やっている予定か、このあと始まる予定。カレンダーの予定と毎週のコマ)
function renderNextEvent(now) {
  const found = currentOrNextItem(timetable, planEvents(), now);
  els.nextEvent.hidden = !found;
  document.documentElement.classList.toggle('has-next-event', Boolean(found));
  if (!found) return;
  const { item, ongoing } = found;
  const text = t(ongoing ? 'nextEventOngoing' : 'nextEventUpcoming', { start: item.start, end: item.end, title: item.title });
  els.nextEvent.textContent = text;
  els.nextEvent.title = text;
  els.nextEvent.classList.toggle('ongoing', ongoing);
}

// 予定 (カレンダーの予定と毎週のコマ) の開始・終了と、予定の前の知らせ。前回確かめた時刻から今までに来たものを出す
// (起動した時刻より前の予定は知らせない。スリープ明けなどで 5 分より遅れたものも出さない)
let lastEventCheck = Date.now();

function checkEvents(now) {
  const due = planTriggers(timetable, planEvents(), lastEventCheck, now);
  // 「あと N 分で〇〇」の知らせ (設定で選んだときだけ。音は鳴らさない)
  const plan = dayPlan(timetable, planEvents(), toDateKey(new Date(now)));
  for (const item of scheduleReminders(plan, lastEventCheck, now, settings.scheduleReminder)) {
    showNotification(t('notifyReminderTitle', { n: settings.scheduleReminder, title: item.title }), t('notifyReminderBody', { start: item.start, end: item.end }));
  }
  lastEventCheck = now;
  for (const { item, kind } of due) {
    if (kind === 'start') startScheduledEvent(item);
    else showNotification(t('notifyEventEndTitle', { title: item.title }), t('notifyEventEndBody', { start: item.start, end: item.end }));
  }
}

// 開始時刻: 止まっていれば、予定のプリセット (毎週のコマや、選んでいない予定は今の設定のまま) で作業の頭に準備する
// (スタートは自分で押す)。動いていれば何も変えない
function startScheduledEvent(item) {
  const title = t('notifyEventStartTitle', { title: item.title });
  if (state.running) {
    showNotification(title, t('notifyEventStartRunning'));
    return;
  }
  const preset = eventPreset(item.preset);
  if (preset) {
    updateSettings(preset.values);
    for (const picker of wheels) picker.setValue(settings[picker.key]);
  }
  state = prepareFocus(state, settings);
  render();
  showNotification(title, t('notifyEventStartPrepared', { preset: presetLabel(item.preset) }));
}

const formatClock = (now) => new Intl.DateTimeFormat(settings.language, { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);

// --- 毎週の時間割 (選んだ日の曜日): まとめて作る・ほかの曜日にコピー・すべて消す・予定の前の知らせ ---
const tools = {
  title: $('timetable-title'),
  generateOpen: $('generate-open'),
  copyOpen: $('copy-open'),
  clearDay: $('clear-day'),
  clearWeekday: $('clear-weekday'),
  generateForm: $('generate-form'),
  generateRepeat: [...document.querySelectorAll('input[name="generate-repeat"]')],
  generateRepeatOnce: $('generate-repeat-once'),
  generateRepeatWeekly: $('generate-repeat-weekly'),
  generateStart: $('generate-start'),
  generatePeriod: $('generate-period'),
  generateBreak: $('generate-break'),
  generateLongBreak: $('generate-long-break'),
  generateLongBreakAfter: $('generate-long-break-after'),
  generateCount: $('generate-count'),
  generatePreview: $('generate-preview'),
  generateError: $('generate-error'),
  generateCancel: $('generate-cancel'),
  copyForm: $('copy-form'),
  copyTitle: $('copy-title'),
  copyDays: $('copy-days'),
  copyError: $('copy-error'),
  copyCancel: $('copy-cancel'),
  reminder: $('schedule-reminder'),
};

// フォーム (予定・まとめて作る・コピー) は、1 つずつしか開かない
function closeToolForms() {
  tools.generateForm.hidden = true;
  tools.copyForm.hidden = true;
}

function renderTimetableTools(busy) {
  const weekday = selectedWeekday();
  const hasSlots = slotsOn(timetable, weekday).length > 0;
  tools.title.textContent = t('timetableSection', { weekday: weekdayName(weekday, 'long') });
  tools.generateOpen.disabled = busy;
  // コピーは、その日だけの予定か毎週のコマがあるとき。この日を消すのは、その日の予定 (くり返す予定の回も) があるとき
  tools.copyOpen.disabled = busy || (!hasSlots && !events.some((event) => isOneOffOn(event, selectedDate)));
  tools.clearDay.disabled = busy || (eventsOn(events, selectedDate).length === 0 && slotsOnDate(timetable, selectedDate).length === 0);
  tools.clearWeekday.disabled = busy || !hasSlots;
  tools.reminder.replaceChildren(...REMINDER_MINUTES.map((n) => {
    const option = document.createElement('option');
    option.value = String(n);
    option.textContent = n === 0 ? t('reminderOff') : t('reminderMinutes', { n });
    return option;
  }));
  tools.reminder.value = String(settings.scheduleReminder);
}

// まとめて作る: 入れた値で、何時から何時までに何コマできるかを先に見せる
const generateFields = {
  start: tools.generateStart,
  period: tools.generatePeriod,
  breakMinutes: tools.generateBreak,
  longBreakMinutes: tools.generateLongBreak,
  longBreakAfter: tools.generateLongBreakAfter,
  count: tools.generateCount,
};

// 入力欄の値 (開始・1 コマ・コマ数・休み・長い休みとその位置)
function generateValues() {
  return Object.fromEntries(Object.entries(generateFields).map(([key, input]) => [key, input.value]));
}

// 「この日だけ」(初め) か「毎週〇曜日」か
const generateWeekly = () => tools.generateRepeat.find((radio) => radio.checked)?.value === 'weekly';
const dateLabel = (key) => formatDate(parseDateKey(key), { month: 'long', day: 'numeric', weekday: 'short' });
const selectedDateLabel = () => dateLabel(selectedDate);

// まとめて作ったときの結果 (保存はしない)。この日だけなら 1 回だけの予定、毎週なら時間割のコマ
function generateResult() {
  const nameFor = (n) => t('generateName', { n });
  return generateWeekly()
    ? generateDay({ weekday: selectedWeekday(), ...generateValues() }, timetable, nameFor)
    : generateDateEvents({ date: selectedDate, ...generateValues() }, events, nameFor);
}

// 入れた値で、どこに・何時から何時まで・何コマできるかを先に見せる
function updateGeneratePreview() {
  const weekly = generateWeekly();
  tools.generateRepeatOnce.textContent = t('generateRepeatOnce', { date: selectedDateLabel() });
  tools.generateRepeatWeekly.textContent = t('eventRepeatWeekly', { weekday: weekdayName(selectedWeekday(), 'long') });
  const result = generateResult();
  tools.generateError.hidden = true;
  if (result.error) {
    tools.generatePreview.textContent = '';
    return result;
  }
  const created = weekly ? slotsOn(result.slots, selectedWeekday()) : result.added;
  const target = weekly ? t('eventRepeatWeekly', { weekday: weekdayName(selectedWeekday(), 'long') }) : selectedDateLabel();
  tools.generatePreview.textContent = t('generatePreview', { target, count: result.created, start: created[0].start, end: created.at(-1).end });
  return result;
}

function openGenerateForm() {
  closeEventFormQuietly();
  tools.copyForm.hidden = true;
  // 初めは「この日だけ」。値は、最後に作ったときの値 (まだ作っていなければ 8:30・45 分・休み 10 分・長い休み 60 分 (4 コマ目のあと)・7 コマ)
  for (const radio of tools.generateRepeat) radio.checked = radio.value === 'once';
  for (const [key, input] of Object.entries(generateFields)) input.value = String(settings.timetableGenerate[key]);
  tools.generateForm.hidden = false;
  updateGeneratePreview();
  renderCalendar();
  tools.generateStart.focus();
}

for (const input of [...Object.values(generateFields), ...tools.generateRepeat]) input.addEventListener('input', updateGeneratePreview);

tools.generateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = updateGeneratePreview();
  if (result.error) {
    tools.generateError.textContent = t(result.error === 'noRoom' ? 'generateErrorNoRoom' : result.error === 'invalidTime' ? 'eventErrorInvalidTime' : 'generateErrorRange');
    tools.generateError.hidden = false;
    return;
  }
  const weekly = generateWeekly();
  const weekday = selectedWeekday();
  // 置き換えるものがあるときは確かめる (毎週ならその曜日の時間割、この日だけならその日の 1 回だけの予定)
  if (weekly) {
    if (slotsOn(timetable, weekday).length > 0 && !confirm(t('confirmReplaceDay', { weekday: weekdayName(weekday, 'long') }))) return;
  } else if (events.some((ev) => isOneOffOn(ev, selectedDate)) && !confirm(t('confirmReplaceDate', { date: selectedDateLabel() }))) {
    return;
  }
  tools.generateForm.hidden = true;
  // 使った値を、次に開いたときの初めの値として覚えておく
  updateSettings({ timetableGenerate: generateValues() });
  if (weekly) saveTimetable(result.slots);
  else saveEvents(result.events);
  tools.generateOpen.focus();
});

function openCopyForm() {
  closeEventFormQuietly();
  tools.generateForm.hidden = true;
  const from = selectedWeekday();
  // 何をどこへコピーするか: その日だけの予定は同じ週 (月曜始まり) のその曜日の日へ、毎週のコマは毎週のその曜日へ
  const dates = weekDates(selectedDate);
  const range = `${formatDate(parseDateKey(dates[1]), { month: 'short', day: 'numeric' })} – ${formatDate(parseDateKey(dates[0]), { month: 'short', day: 'numeric' })}`;
  const notes = [];
  if (events.some((event) => isOneOffOn(event, selectedDate))) notes.push(t('copyNoteDate', { range }));
  if (slotsOn(timetable, from).length > 0) notes.push(t('copyNoteWeekly', { weekday: weekdayName(from, 'long') }));
  tools.copyTitle.textContent = [t('copyTitle', { date: selectedDateLabel() }), ...notes].join(' ');
  tools.copyDays.replaceChildren(...WEEKDAY_ORDER.map((weekday) => {
    const label = document.createElement('label');
    label.className = 'copy-day';
    label.classList.toggle('sun', weekday === 0);
    label.classList.toggle('sat', weekday === 6);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(weekday);
    box.disabled = weekday === from; // コピー元の曜日
    box.setAttribute('aria-label', weekdayName(weekday, 'long'));
    const name = document.createElement('span');
    name.textContent = weekdayName(weekday, 'short');
    name.setAttribute('aria-hidden', 'true');
    label.append(box, name);
    return label;
  }));
  tools.copyError.hidden = true;
  tools.copyForm.hidden = false;
  renderCalendar();
  tools.copyDays.querySelector('input:not(:disabled)')?.focus();
}

tools.copyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const targets = [...tools.copyDays.querySelectorAll('input:checked')].map((box) => Number(box.value));
  const showError = (key) => {
    tools.copyError.textContent = t(key, { max: MAX_SLOTS });
    tools.copyError.hidden = false;
  };
  if (targets.length === 0) return showError('copyErrorNone');
  const from = selectedWeekday();
  const dates = weekDates(selectedDate);
  const copyEvents = events.some((event) => isOneOffOn(event, selectedDate));
  const copySlots = slotsOn(timetable, from).length > 0;
  const nextEvents = copyEvents ? copyDateEvents(events, selectedDate, targets.map((weekday) => dates[weekday])) : events;
  if (!nextEvents) {
    tools.copyError.textContent = t('eventErrorFull', { max: MAX_EVENTS });
    tools.copyError.hidden = false;
    return;
  }
  const nextTimetable = copySlots ? copyDay(timetable, from, targets) : timetable;
  if (!nextTimetable) return showError('copyErrorFull');
  // コピー先にある予定 (その日だけの予定・毎週のコマ) は置き換わるので、あれば確かめる
  const replaced = [];
  for (const weekday of WEEKDAY_ORDER.filter((w) => targets.includes(w))) {
    if (copyEvents && events.some((event) => isOneOffOn(event, dates[weekday]))) replaced.push(t('itemDateEvents', { date: dateLabel(dates[weekday]) }));
    if (copySlots && slotsOn(timetable, weekday).length > 0) replaced.push(t('itemWeekly', { weekday: weekdayName(weekday, 'long') }));
  }
  if (replaced.length > 0 && !confirm(t('confirmReplaceItems', { items: replaced.join(t('listSeparator')) }))) return;
  tools.copyForm.hidden = true;
  events = nextEvents;
  save('events', events);
  saveTimetable(nextTimetable);
  tools.copyOpen.focus();
});

tools.generateOpen.addEventListener('click', openGenerateForm);
tools.copyOpen.addEventListener('click', openCopyForm);
// 1 つずつ消すときと違い、まとめて消えるので確認する
// この日をすべて消す: その日だけの予定は消し、くり返す予定と毎週の時間割はその日だけ休みにする (ほかの日・週は残る)
tools.clearDay.addEventListener('click', () => {
  const hasWeekly = slotsOnDate(timetable, selectedDate).length > 0;
  if (!confirm(t(hasWeekly ? 'confirmClearDateWeekly' : 'confirmClearDate', { date: selectedDateLabel() }))) return;
  events = clearDate(events, selectedDate);
  save('events', events);
  saveTimetable(skipSlotsOn(timetable, selectedDate));
  cal.add.focus();
});
// この曜日をすべて消す: その曜日の毎週の時間割を、すべての週から消す
tools.clearWeekday.addEventListener('click', () => {
  const weekday = selectedWeekday();
  if (!confirm(t('confirmClearWeekday', { weekday: weekdayName(weekday, 'long') }))) return;
  saveTimetable(replaceDay(timetable, weekday, []));
  tools.generateOpen.focus();
});
for (const [form, cancel, opener] of [[tools.generateForm, tools.generateCancel, tools.generateOpen], [tools.copyForm, tools.copyCancel, tools.copyOpen]]) {
  const close = () => {
    form.hidden = true;
    renderCalendar();
    opener.focus();
  };
  cancel.addEventListener('click', close);
  // フォームの中の Esc は、カレンダーを閉じずにフォームだけを閉じる
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  });
}
tools.reminder.addEventListener('change', () => updateSettings({ scheduleReminder: tools.reminder.value }));

// 取り込んだファイルの一覧を読み込む。選んでいたファイルが見つからなければ (手で消された場合など)「なし」に戻す
async function loadMedia() {
  if (!window.media) return;
  [media.wallpapers, media.bgm] = await Promise.all([window.media.list('wallpapers'), window.media.list('bgm')]);
  const missing = (kind, id) => id.startsWith('import:') && !media[kind].some((m) => `import:${m.file}` === id);
  const patch = {};
  if (missing('wallpapers', settings.wallpaper)) patch.wallpaper = 'none';
  if (missing('bgm', settings.bgm)) patch.bgm = 'none';
  updateSettings(patch);
}

// --- 自動アップデートの案内 ---
// window.updater は preload.cjs が用意する。ブラウザで直接開いたときなどは存在しないので、何もしない
const UPDATE_VIEW = {
  available: { text: (u) => t('updateAvailable', { version: u.version }), action: 'updateNow', later: true },
  downloading: { text: (u) => t('downloading', { percent: u.percent }), action: null, later: false },
  downloaded: { text: () => t('updateReady'), action: 'restartToUpdate', later: true },
  error: { text: () => t('updateFailed'), action: 'retry', later: true },
};

let updateState = INITIAL_UPDATE_STATE;

function dispatchUpdate(event) {
  updateState = nextUpdateState(updateState, event);
  renderUpdate();
}

function renderUpdate() {
  const visible = isBannerVisible(updateState);
  els.updateBanner.hidden = !visible;
  if (!visible) return;
  const view = UPDATE_VIEW[updateState.phase];
  els.updateText.textContent = view.text(updateState);
  els.updateProgress.hidden = updateState.phase !== 'downloading';
  els.updateProgress.value = updateState.percent;
  els.updateAction.hidden = !view.action;
  els.updateAction.textContent = view.action ? t(view.action) : '';
  els.updateLater.hidden = !view.later;
}

if (window.updater) {
  window.updater.onEvent(dispatchUpdate);
  window.updater.getVersion().then((version) => {
    appVersion = version;
    els.appVersion.textContent = t('version', { version });
    els.appVersion.hidden = false;
  });

  els.updateAction.addEventListener('click', () => {
    if (updateState.phase === 'downloaded') {
      // 再起動するとタイマーが止まるので、動いているときは確認する
      if (state.running && !confirm(t('confirmRestart'))) return;
      window.updater.install();
      return;
    }
    dispatchUpdate({ type: 'download-start' });
    // 失敗はメインプロセスからの error イベントでも届くが、念のためここでも受け取る
    window.updater.download().catch((error) => dispatchUpdate({ type: 'error', message: String(error) }));
  });
  els.updateLater.addEventListener('click', () => dispatchUpdate({ type: 'dismiss' }));
}

// --- 外部カレンダー (Google カレンダーなどの iCal 形式の非公開 URL。calendar-feeds.js が取り込む。アプリのときだけ) ---
const feedsUi = {
  section: $('feeds-section'),
  list: $('feed-list'),
  form: $('feed-form'),
  name: $('feed-name'),
  url: $('feed-url'),
  add: $('feed-add'),
  error: $('feed-error'),
  refresh: $('feeds-refresh'),
};
// 登録できる数。src/ical-feed.js の MAX_FEEDS と同じ (画面は ical.js を読み込めないので、数だけここに持つ)
const MAX_FEEDS_UI = 5;

// 取り込んだ回を、カレンダーの予定と同じ形 (1 回だけの予定) と、終日の予定に分ける。名前がなければ仮の名前
function applyExternal({ feeds, events: list, available }) {
  const named = (e) => ({ ...e, title: e.title || t('eventUntitled') });
  external = {
    feeds,
    available,
    events: list.filter((e) => !e.allDay).map((e) => ({ ...named(e), preset: null, repeat: 'none', until: null, skips: [] })),
    allDay: list.filter((e) => e.allDay).map(named),
  };
  renderFeeds();
  renderCalendar();
  render();
}

async function loadExternal() {
  applyExternal(await window.calendarFeeds.list());
}

function showFeedError(code) {
  feedsUi.error.textContent = code ? t(`feedError.${code}`) : '';
  feedsUi.error.hidden = !code;
}

function renderFeeds() {
  if (!window.calendarFeeds) return;
  feedsUi.list.replaceChildren(...external.feeds.map((feed) => {
    const item = document.createElement('li');
    item.className = 'feed-item';
    const info = document.createElement('div');
    info.className = 'feed-info';
    const name = document.createElement('span');
    name.className = 'feed-name';
    name.textContent = feed.name;
    const status = document.createElement('span');
    status.className = 'feed-status';
    status.classList.toggle('error', Boolean(feed.error));
    // 読めなかったときは理由を出す (前に読めた予定は、そのまま使い続ける)
    status.textContent = feed.error
      ? t(`feedError.${feed.error}`)
      : feed.fetchedAt
        ? t('feedStatus', { time: formatDate(new Date(feed.fetchedAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }), count: feed.count })
        : t('feedNever');
    info.append(name, status);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', t('remove', { name: feed.name }));
    // 外すと、アドレスを貼り直さないと戻せないので確認する
    remove.addEventListener('click', () => {
      if (confirm(t('confirmFeedRemove', { name: feed.name }))) window.calendarFeeds.remove(feed.id);
    });
    item.append(info, remove);
    return item;
  }));
  feedsUi.form.hidden = external.feeds.length >= MAX_FEEDS_UI;
  feedsUi.refresh.disabled = external.feeds.length === 0;
  feedsUi.add.disabled = !external.available;
  if (!external.available) showFeedError('noEncryption');
}

if (window.calendarFeeds) {
  feedsUi.section.hidden = false;
  feedsUi.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showFeedError(null);
    feedsUi.add.disabled = true;
    feedsUi.add.textContent = t('feedAdding');
    // 登録する前に、メインプロセスが 1 回読んで、カレンダーとして読めるかを確かめる
    const result = await window.calendarFeeds.add({
      name: feedsUi.name.value,
      url: feedsUi.url.value,
      fallbackName: t('feedDefaultName', { n: external.feeds.length + 1 }),
    });
    feedsUi.add.disabled = false;
    feedsUi.add.textContent = t('feedAdd');
    if (result.error) {
      showFeedError(result.error);
      return;
    }
    feedsUi.name.value = '';
    feedsUi.url.value = '';
  });
  feedsUi.refresh.addEventListener('click', async () => {
    feedsUi.refresh.disabled = true;
    await window.calendarFeeds.refresh();
    feedsUi.refresh.disabled = external.feeds.length === 0;
  });
  // 読み直し・追加・削除のたびに、メインプロセスから知らせが来る
  window.calendarFeeds.onChange(() => loadExternal());
  loadExternal();
}

// 表示更新は 0.25 秒ごと。残り時間は終了予定時刻から計算するので、間隔がズレても誤差は出ない
applyAppearance();
applyLanguage();
bgm.setSource(settings.bgm);
bgm.setVolume(effectiveVolume(settings, 'bgmVolume'));
renderVolumes();
renderChoices();
loadMedia();
setInterval(update, 250);
render();
