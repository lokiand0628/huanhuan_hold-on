/**
 * 状态层：唯一数据源。
 *
 * 后端是计时的唯一真源，这里只存配置与展示态。
 *
 * 硬约束（旧版栽过的地方）：**UI 状态也要进 store**。旧版"哪张卡展开着"
 * 只存在 DOM 的 data-open 上，于是任何一个动作触发重绘，展开的卡片就塌掉。
 */
import { BUILTIN, BUILTIN_IDS, taskTitle as titleOf } from './strings.js';
import { normalizeIconName } from '../ui/icons.js';

// icon 显式写出来，不再靠"id 恰好等于图标名"这个巧合 —— 内置任务的 id 是
// sit/water/eye，而图标名已经换成 person-standing/glass-water/eye，两者不再重合。
const DEFAULT_TASKS = [
  { id: 'sit', icon: 'person-standing', interval: 45, snoozeMinutes: 5 },
  { id: 'water', icon: 'glass-water', interval: 60, snoozeMinutes: 5 },
  { id: 'eye', icon: 'eye', interval: 20, snoozeMinutes: 2 },
];

/**
 * 休息时长的边界（秒）与单位表。
 *
 * 上限 12 小时不是为了拦你 —— 是为了别让"想输 30 分钟、多按一个 0"
 * 变成锁到明天。旧版上限只有 600 秒（10 分钟），所以"设很久"根本敲不进去。
 */
export const DURATION_MIN = 1;
export const DURATION_MAX = 12 * 3600;
export const DURATION_UNITS = { sec: 1, min: 60, hour: 3600 };

/**
 * 一个秒数"最自然"的单位：能整除掉的最大单位。
 * 90 秒 → 秒（60 除得尽但 90/60 不是整数，所以仍用秒），120 → 分钟，7200 → 小时。
 */
function bestUnit(seconds) {
  if (seconds % DURATION_UNITS.hour === 0 && seconds >= DURATION_UNITS.hour) return 'hour';
  if (seconds % DURATION_UNITS.min === 0 && seconds >= DURATION_UNITS.min) return 'min';
  return 'sec';
}

const DEFAULTS = {
  tasks: DEFAULT_TASKS,
  soundEnabled: true,
  customSoundPath: '',
  autoStart: false,
  silentAutoStart: true,
  // 休息时怎么处理视频和音乐：none / video / all
  lockMediaMode: 'none',
  // 人离开电脑就重新计时
  resetOnIdle: true,
  // 离开多久算离开（秒）
  idleThreshold: 300,
  // 新提醒的默认休息时长（秒）
  lockDuration: 60,
  lockScreenBgImage: '',
};

export const state = {
  settings: structuredClone(DEFAULTS),
  countdowns: {},
  pausedTasks: {},
  isPaused: false,
  isIdle: false,
  version: '—',

  // 路由内的展示态
  tab: 'tasks',
  expandedTaskId: null,
  // 定时时间输入框里"还没按加号"的半成品。放在 store 里，
  // 因为它必须扛得住重绘 —— 放下一个时间点时不该把正在输入的那个清掉。
  timeDrafts: {},

  // 触发展示层
  focus: null,
  lock: null,

  toasts: [],
};

/* ============================== 查询 ============================== */

export function taskById(id) {
  return state.settings.tasks.find(t => t.id === id) || null;
}

export function taskTitle(task) {
  return titleOf(task);
}

export function isDaily(task) {
  return (
    task?.scheduleType === 'daily' && Array.isArray(task.dailyTimes) && task.dailyTimes.length > 0
  );
}

function nextCustomId() {
  return `task_${Date.now().toString(36)}`;
}

/* ============================== 迁移与归一化 ============================== */

/** 秒 → 分钟的稳定取整，用于把老配置里的 5 秒预告抬到合理区间 */
export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeTimes(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s，、]+/);
  const out = [];
  for (const item of list) {
    const m = String(item)
      .trim()
      .match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) continue;
    const hk = Number(m[1]);
    const mk = Number(m[2]);
    if (hk > 23 || mk > 59) continue;
    const time = `${String(hk).padStart(2, '0')}:${String(mk).padStart(2, '0')}`;
    if (!out.includes(time)) out.push(time);
  }
  return out.sort();
}

/**
 * 归一化配置。老 settings.json 不能炸 —— 认不出来的字段**静默丢掉**，
 * 缺的补默认值。
 *
 * 这一版丢掉的老字段（各自都有替代）：
 *   forceMode            闸门现在是常驻的，不再是开关
 *   enableMerge / mergeThreshold   不再做"合并提醒"
 *   focusSticky / autoFinish       柔和提醒现在恒为"确认才消失"
 *   maxSnoozeCount                 改成每个提醒自己的 maxSnooze
 *   language / language_switch_hint  只剩中文
 *   checkUpdatesOnLaunch           本来就没有任何代码读它
 *   floatingWindow* ×13            悬浮窗子系统整个删了
 */
export function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const merged = { ...structuredClone(DEFAULTS), ...source };

  // 只保留认识的键，其余一律丢弃 —— 免得老字段被原样写回去，越滚越大
  const settings = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'tasks') continue;
    settings[key] = merged[key];
  }

  settings.soundEnabled = settings.soundEnabled !== false;
  settings.customSoundPath = String(settings.customSoundPath || '');
  settings.autoStart = settings.autoStart === true;
  settings.silentAutoStart = settings.silentAutoStart !== false;
  settings.resetOnIdle = settings.resetOnIdle !== false;
  settings.lockScreenBgImage = String(settings.lockScreenBgImage || '');

  if (!['none', 'video', 'all'].includes(settings.lockMediaMode)) {
    settings.lockMediaMode = 'none';
  }
  settings.idleThreshold = clampInt(settings.idleThreshold, 30, 3600, 300);
  settings.lockDuration = clampInt(settings.lockDuration, DURATION_MIN, DURATION_MAX, 60);

  const tasks = Array.isArray(source.tasks) && source.tasks.length ? source.tasks : defaultTasks();
  settings.tasks = tasks.map(normalizeTask);

  return settings;
}

function defaultTasks() {
  return DEFAULT_TASKS.map(base => normalizeTask({ ...base, title: '', desc: '' }));
}

function normalizeTask(rawTask) {
  const id = String(rawTask?.id || '');
  const builtin = BUILTIN_IDS.includes(id);
  const base = builtin ? DEFAULT_TASKS.find(d => d.id === id) : null;

  // 图标有三个来源，按优先级：用户选过的 `icon` → 更早的字段名 `tone`
  // → 内置任务按 id 推断（老配置里内置任务压根没存过图标）。
  // normalizeIconName 同时认新名字和老名字（sit/water/eye/custom），
  // 所以老配置读出来是 person-standing 而不是悄悄变成"自定义"。
  const icon =
    normalizeIconName(rawTask?.icon) ||
    normalizeIconName(rawTask?.tone) ||
    normalizeIconName(builtin ? id : null) ||
    'sparkles';

  const task = {
    id,
    // 空串表示"用内置文案"，由 strings.js 的 BUILTIN 兜底。
    // 老配置里 titleKey/descKey 一律丢掉 —— 只剩中文，键没用了。
    title: String(rawTask?.title || ''),
    desc: String(rawTask?.desc || ''),
    icon,
    interval: clampInt(rawTask?.interval, 1, 1440, base?.interval ?? 30),
    enabled: rawTask?.enabled !== false,
    scheduleType: rawTask?.scheduleType === 'daily' ? 'daily' : 'interval',
    dailyTimes: normalizeTimes(rawTask?.dailyTimes).slice(0, 12),
    reminderMode: rawTask?.reminderMode === 'lock' ? 'lock' : 'focus',
    lockDuration: clampInt(rawTask?.lockDuration, DURATION_MIN, DURATION_MAX, 60),
    // 秒数决定"多久"，单位只决定"显示成 90 分钟还是 1.5 小时"。
    // 两者是同一个值的两种写法，所以单位是纯展示态 —— 但它必须落盘：
    // 不然重开一次，"90 分钟"就自己变成"1.5 小时"了。
    durationUnit: ['sec', 'min', 'hour'].includes(rawTask?.durationUnit)
      ? rawTask.durationUnit
      : bestUnit(clampInt(rawTask?.lockDuration, DURATION_MIN, DURATION_MAX, 60)),
    preNotificationSeconds: clampInt(rawTask?.preNotificationSeconds, 0, 300, 5),
    snoozeMinutes: clampInt(rawTask?.snoozeMinutes, 1, 120, base?.snoozeMinutes ?? 5),
    maxSnooze: clampInt(rawTask?.maxSnooze, 0, 10, 3),
    autoResetOnIdle: rawTask?.autoResetOnIdle !== false,
  };

  // 定点模式至少要有一个时间点，否则后端调度不出来东西
  if (task.scheduleType === 'daily' && task.dailyTimes.length === 0) {
    task.scheduleType = 'interval';
  }

  return task;
}

export function newTask() {
  const water = taskById('water');
  return normalizeTask({
    id: nextCustomId(),
    title: '',
    desc: '',
    icon: 'sparkles',
    interval: water?.interval ?? 30,
    enabled: true,
    reminderMode: 'focus',
    lockDuration: water?.lockDuration ?? 60,
    preNotificationSeconds: water?.preNotificationSeconds ?? 5,
    snoozeMinutes: water?.snoozeMinutes ?? 5,
    maxSnooze: water?.maxSnooze ?? 3,
  });
}

/** 序列化回 settings.json。只写认识的键。 */
export function serialize() {
  return JSON.stringify(state.settings, null, 2);
}

/** 供后端使用的最小投影：字段必须与 Rust 端 TaskConfig 一致 */
export function toBackendTasks() {
  return state.settings.tasks.map(task => ({
    id: task.id,
    title: titleOf(task),
    desc: task.desc || BUILTIN[task.id]?.desc || '',
    interval: task.interval,
    enabled: task.enabled,
    icon: task.icon,
    auto_reset_on_idle: state.settings.resetOnIdle,
    schedule_type: task.scheduleType,
    daily_times: task.dailyTimes,
  }));
}
