/**
 * 全部界面文案（中文 / English）。
 *
 * 两份表结构必须**完全一致**：键是同一批，函数键的参数也一致。少一个键不会报错，
 * 只会在界面上留一块空白 —— 所以拿不准就两边都加。
 *
 * 切换语言走 `setLanguage()`：它重新赋值 `S`（`export let`），而 ESM 是活绑定，
 * 所有 `import { S }` 的地方下次读 `S.xxx` 就是新语言。**代价是必须每次现读**：
 * 谁把 `S.xxx` 提前解构到模块作用域（`const { noTasks } = S`），那个字符串就
 * 永远停在启动时的语言。
 *
 * 注释保持中文：这是给维护者看的，不参与界面。翻译只做 `zh` / `en` 两张表。
 */

/* ============================== 中文 ============================== */

const zh = {
  // 中文名「缓缓」，英文名 Hold On。
  appName: '缓缓',
  appTagline: '事缓则圆，不着急～',

  /* ---- 页签 ---- */
  tabTasks: '提醒',
  tabSettings: '设置',

  /* ---- 提醒页 ---- */
  tasksTitle: '提醒',
  nextPrefix: '下一个',
  noTasks: '还没有提醒，先加一个吧',
  paused: '已全部暂停',
  idle: '你离开了，计时先停着',
  notScheduled: '未安排',
  addTask: '添加提醒',
  done: '已完成',
  modeFocus: '居中浮窗',
  modeLock: '锁屏强制',
  pauseAll: '全部暂停',
  resumeAll: '全部继续',
  resetAll: '全部重新计时',

  /* ---- 任务编辑 ---- */
  taskName: '名称',
  taskIcon: '图标',
  taskSchedule: '什么时候提醒',
  scheduleInterval: '每隔多久',
  scheduleDaily: '每天几点',
  taskInterval: '间隔',
  // 「每天几点」那一行自己的标题。以前它跟上面的分段控件共用
  // 「什么时候提醒」—— 同一个标题在一屏里出现两次，看着像渲染错了。
  taskTimes: '提醒时间',
  addTime: '加一个时间',
  timePlaceholder: '例如 22:00',
  taskMode: '提醒方式',
  modeFocusHint: '桌面中间弹一个小窗，点确认才消失',
  modeLockHint: '全屏强制休息，中途退不出去',
  taskLockDuration: '休息多久',
  taskPreNotify: '提前几秒提醒',
  taskSnooze: '可以推迟几分钟',
  deleteTask: '删除这个提醒',
  deleteTaskConfirm: title => `删除「${title}」？这个操作撤不回来。`,
  newTaskTitle: '新提醒',
  minutes: '分钟',
  seconds: '秒',
  hours: '小时',

  // 休息时长超过这道线，往大改就要验指纹 —— 见 actions.js 的 applyDuration。
  // 这是自律工具里唯一一处"加码需要授权"的地方：临时起意把 30 分钟改成
  // 3 小时（或者反过来事后偷偷改短）都该是一次有意识的动作。
  durationAuthHint: '超过 10 分钟要按指纹或输密码',

  /* ---- 设置页 ---- */
  settingsTitle: '设置',
  groupBreak: '强制休息',
  groupGeneral: '声音与启动',
  groupLook: '外观与语言',
  groupAbout: '关于',

  language: '语言',

  mediaDuringBreak: '休息时怎么处理视频和音乐',
  mediaNone: '不处理',
  mediaVideo: '只暂停视频',
  mediaAll: '全都暂停',
  resetOnIdle: '离开电脑就重新计时',
  resetOnIdleDesc: '人不在的时候不该催你休息',
  idleThreshold: '离开多久算离开',
  soundEnabled: '提示音',
  customSound: '自定义提示音',
  pickSound: '选一个音频文件',
  changeSound: '换一个',
  testSound: '试听',
  noCustomSound: '用系统默认',
  autoStart: '开机自动启动',
  autoStartDesc: '登录后自动运行，缩在托盘里',
  silentStart: '静默启动',
  silentStartDesc: '启动后不弹窗，直接待在托盘',
  bgImage: '休息背景图',
  bgImageDesc: '锁屏时垫在后面的一张图',
  pickImage: '选一张图',
  changeImage: '换一张',
  clearImage: '不用背景图',
  version: v => `版本 ${v}`,
  checkUpdate: '检查更新',

  // 「关于作者」这两行是给用户一个能找着人的地方：这是个自用小工具，
  // 但既然发出去了，就得让人知道是谁写的、去哪儿提问题。
  aboutAuthor: '关于作者',
  authorName: '砖头',
  authorProject: '项目地址',
  authorHome: 'GitHub 主页',
  quickStar: '快捷标星',
  quickStarDesc: '如果它帮到你了，去 GitHub 点个 star 吧',
  quickStarAction: '去标星',
  // 标星只能人自己点 —— 这里能做的只是把页面送到他面前，
  // 所以得说清楚"接下来点哪儿"，不然打开一个满屏文字的仓库页等于没帮上忙。
  toastStarHint: '在打开的页面右上角点一下 ⭐ Star 就标上了',

  /* ---- 居中浮窗 ---- */
  reminderConfirm: '知道了',
  // 以前是「稍后再说 (2)」，那个括号里的数字是"还剩几次"，但看着像倒计时。
  // 现在软提醒只给一次推迟，数字没了意义，直接把"多久之后再来"写进去。
  reminderSnooze: n => `${n} 分钟后再提醒你`,

  /* ---- 锁屏 ---- */
  lockKicker: '该休息了',
  lockRemaining: '剩余时间',
  lockFinish: '完成休息',
  lockSnooze: minutes => `推迟 ${minutes} 分钟`,
  // 锁屏强制的推迟和软提醒一样只给一次 —— 这句不报次数，只把"仅此一次"说明白。
  // 从前这里是「还能推迟 N 次」，而那个 N 永远停在初始值：预算存在 lock.json 里，
  // 推迟会整场结束这次锁、连文件一起删掉，下一次触发又是满格。写一个不会变的
  // 数字比不写更糟 —— 它让人以为还有很多次，然后发现可以无限点。
  lockSnoozeOnce: '只有这一次，到点会重新开始休息',
  lockEmergency: '紧急情况，需要继续用电脑',
  lockGateTitle: '输入下面这段文字来解除',

  /* ---- 闸门 ---- */
  gateHint: '这是故意做得很难的出口。粘不上，只能一个字一个字敲。',
  gateProgress: (matched, total) => `已输入 ${matched} / ${total}`,
  gateWrong: '这里跟上面不一样',
  gatePass: '对上了，可以解除',
  gateDone: '解除休息',
  gateWaiting: '还没输完',
  gatePlaceholder: '在这里一个字一个字打出来',

  /* ---- 日程描述 ---- */
  everyNMinutes: n => `每 ${n} 分钟`,
  // 定点时间的连接符：中文用顿号，英文得用逗号加空格。
  listSeparator: '、',
  healthReminder: '健康提醒',
  minutesShort: n => `${n} 分`,

  /* ---- 无障碍标签（读屏软件会念出来，一样要翻）---- */
  decrease: '减少',
  increase: '增加',
  collapse: '收起',
  expand: '展开',
  removeTime: time => `删除 ${time}`,

  /* ---- 文件选择对话框里的类型名 ---- */
  filterAudio: '音频',
  filterImage: '图片',

  /* ---- 更新 ---- */
  // 本版**不做**自动下载安装：只问一句 GitHub 上有没有更新的 tag，
  // 有就把人引到仓库的 release 页。用户已明确要这个形态。
  updateLatest: '已经是最新版',
  updateAvailable: v => `有新版本 ${v}，去仓库看看`,
  updateFail: '查不了更新，检查一下网络',

  /* ---- 指纹 / 密码 ---- */
  authReason: '改休息时长',
  authFail: '没验证过，时长没改',

  /* ---- 提示 ---- */
  toastDeleted: '已删除',
  toastNoTime: '先选一个时间',
  toastBadTime: '时间格式不对，像 22:00 或 2200 这样写',
  toastDupeTime: '这个时间已经加过了',
  /** 强制休息期间按 Cmd+Q / 点托盘「退出」时的回执。挡是 Rust 挡的，这句只负责"别静默" */
  exitBlockedLocked: '强制休息中，结束前不能退出',
};

/* ============================== English ============================== */

const en = {
  appName: 'Hold On',
  appTagline: 'Slow down. No rush.',

  /* ---- tabs ---- */
  tabTasks: 'Reminders',
  tabSettings: 'Settings',

  /* ---- reminders page ---- */
  tasksTitle: 'Reminders',
  nextPrefix: 'Next',
  noTasks: 'No reminders yet — add one',
  paused: 'All paused',
  idle: 'You stepped away — timers are paused',
  notScheduled: 'Not scheduled',
  addTask: 'Add reminder',
  done: 'Done',
  modeFocus: 'Floating popup',
  modeLock: 'Forced full screen',
  pauseAll: 'Pause all',
  resumeAll: 'Resume all',
  resetAll: 'Restart all timers',

  /* ---- task editor ---- */
  taskName: 'Name',
  taskIcon: 'Icon',
  taskSchedule: 'When to remind',
  scheduleInterval: 'On an interval',
  scheduleDaily: 'At fixed times',
  taskInterval: 'Interval',
  taskTimes: 'Times',
  addTime: 'Add a time',
  timePlaceholder: 'e.g. 22:00',
  taskMode: 'Reminder style',
  modeFocusHint: 'A small window in the middle of the screen, gone only after you confirm',
  modeLockHint: 'Full screen forced break — you cannot leave early',
  taskLockDuration: 'Break length',
  taskPreNotify: 'Warn this many seconds before',
  taskSnooze: 'Snooze length in minutes',
  deleteTask: 'Delete this reminder',
  deleteTaskConfirm: title => `Delete “${title}”? This cannot be undone.`,
  newTaskTitle: 'New reminder',
  minutes: 'minutes',
  seconds: 'seconds',
  hours: 'hours',
  durationAuthHint: 'Anything over 10 minutes needs Touch ID or your password',

  /* ---- settings page ---- */
  settingsTitle: 'Settings',
  groupBreak: 'Forced breaks',
  groupGeneral: 'Sound & startup',
  groupLook: 'Appearance & language',
  groupAbout: 'About',

  language: 'Language',

  mediaDuringBreak: 'What to do with video and music during breaks',
  mediaNone: 'Leave it alone',
  mediaVideo: 'Pause video only',
  mediaAll: 'Pause everything',
  resetOnIdle: 'Restart timers when you step away',
  resetOnIdleDesc: 'No point nagging you while you are not there',
  idleThreshold: 'Count as away after',
  soundEnabled: 'Sound',
  customSound: 'Custom sound',
  pickSound: 'Choose an audio file',
  changeSound: 'Change',
  testSound: 'Preview',
  noCustomSound: 'System default',
  autoStart: 'Launch at login',
  autoStartDesc: 'Runs in the tray after you log in',
  silentStart: 'Silent start',
  silentStartDesc: 'No window on startup — it goes straight to the tray',
  bgImage: 'Break background',
  bgImageDesc: 'An image shown behind the forced break',
  pickImage: 'Choose an image',
  changeImage: 'Change',
  clearImage: 'No background image',
  version: v => `Version ${v}`,
  checkUpdate: 'Check for updates',

  aboutAuthor: 'About the author',
  authorName: 'ZhuanTou',
  authorProject: 'Repository',
  authorHome: 'GitHub profile',
  quickStar: 'Star the project',
  quickStarDesc: 'If this helped you, drop a star on GitHub',
  quickStarAction: 'Star it',
  toastStarHint: 'Click ⭐ Star at the top right of the page that just opened',

  /* ---- floating popup ---- */
  reminderConfirm: 'Got it',
  reminderSnooze: n => `Remind me again in ${n} min`,

  /* ---- forced break ---- */
  lockKicker: 'Time to rest',
  lockRemaining: 'Remaining',
  lockFinish: 'Finish break',
  lockSnooze: minutes => `Snooze ${minutes} min`,
  lockSnoozeOnce: 'Only once — the break starts over when the snooze ends',
  lockEmergency: 'Emergency — I need to keep using the computer',
  lockGateTitle: 'Type the text below to unlock',

  /* ---- gate ---- */
  gateHint: 'This exit is deliberately hard. Pasting does not work — every character must be typed.',
  gateProgress: (matched, total) => `${matched} / ${total} typed`,
  gateWrong: 'This character does not match',
  gatePass: 'Matched — you can unlock',
  gateDone: 'End the break',
  gateWaiting: 'Not finished yet',
  gatePlaceholder: 'Type it here, one character at a time',

  /* ---- schedule description ---- */
  everyNMinutes: n => (Number(n) === 1 ? 'Every minute' : `Every ${n} minutes`),
  listSeparator: ', ',
  healthReminder: 'Health reminders',
  minutesShort: n => `${n}m`,

  /* ---- accessibility labels ---- */
  decrease: 'Decrease',
  increase: 'Increase',
  collapse: 'Collapse',
  expand: 'Expand',
  removeTime: time => `Remove ${time}`,

  /* ---- file dialog type names ---- */
  filterAudio: 'Audio',
  filterImage: 'Images',

  /* ---- updates ---- */
  updateLatest: 'You are on the latest version',
  updateAvailable: v => `Version ${v} is available — take a look`,
  updateFail: 'Could not check for updates — check your connection',

  /* ---- Touch ID / password ---- */
  authReason: 'Change break length',
  authFail: 'Not verified — the length was not changed',

  /* ---- toasts ---- */
  toastDeleted: 'Deleted',
  toastNoTime: 'Pick a time first',
  toastBadTime: 'Bad time format — write it like 22:00 or 2200',
  toastDupeTime: 'That time is already in the list',
  exitBlockedLocked: 'A forced break is running — you cannot quit until it ends',
};

/* ============================== 切换机制 ============================== */

/** 界面里给用户选的语言。名字用它自己的语言写，两种界面下都一样。 */
export const LANGUAGES = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const TABLES = { zh, en };

/**
 * 两张表本身。**界面代码不要用它** —— 界面一律读 `S`（活绑定，跟着语言走）。
 * 它导出只为给 `scripts/check-i18n.mjs` 做键对齐检查：少一个键在英文界面下
 * 是静默空白，不看这张表发现不了。
 */
export const STRINGS = TABLES;

let current = 'zh';

/**
 * 当前语言的文案表。
 *
 * `export let` 是刻意的：ESM 的活绑定让 `S = en` 能被所有 import 方看见。
 * 换成"永远导出同一个对象、只改它的键"也能达到同样效果，但那样少一个键就会
 * 静默残留旧语言 —— 整体换表更不容易出这种半截状态。
 */
export let S = zh;

export function setLanguage(lang) {
  current = TABLES[lang] ? lang : 'zh';
  S = TABLES[current];
  return current;
}

export function currentLanguage() {
  return current;
}

/** 系统语言 → 我们的两种。非 zh 一律 en。 */
export function detectSystemLanguage() {
  const raw = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) || '';
  return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 我们的短码 → Rust 侧认的完整 tag（那边按 `== "en-US"` 判英文）。 */
export function languageTag(lang) {
  return lang === 'en' ? 'en-US' : 'zh-CN';
}

/* ============================== 内置任务 ============================== */

/** 内置任务的标题与说明。用户改过之后就用用户自己的（title/desc 非空）。 */
const BUILTIN_ZH = {
  sit: { title: '久坐提醒', desc: '站起来活动一下，别连着坐太久' },
  water: { title: '喝水提醒', desc: '去接杯水，顺便走两步' },
  eye: { title: '护眼提醒', desc: '看看远处，让眼睛歇一会儿' },
};

const BUILTIN_EN = {
  sit: { title: 'Stand up', desc: 'Get up and move around — do not sit for so long' },
  water: { title: 'Drink water', desc: 'Grab a glass of water and walk a couple of steps' },
  eye: { title: 'Rest your eyes', desc: 'Look into the distance and let your eyes rest' },
};

/** 当前语言下的内置任务表。用函数而不是常量：语言一换它就得跟着换。 */
export function builtinTasks() {
  return current === 'en' ? BUILTIN_EN : BUILTIN_ZH;
}

/** id 集合两种语言一样，所以这个可以是常量。 */
export const BUILTIN_IDS = Object.keys(BUILTIN_ZH);

export function taskTitle(task) {
  if (!task) return '';
  if (task.title) return task.title;
  return builtinTasks()[task.id]?.title || S.newTaskTitle;
}

export function taskDesc(task) {
  if (!task) return '';
  if (task.desc) return task.desc;
  return builtinTasks()[task.id]?.desc || '';
}
