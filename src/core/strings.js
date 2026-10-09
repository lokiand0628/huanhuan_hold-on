/**
 * 全部界面文案。
 *
 * 只有一个语言，所以不是 i18n —— 是一份集中可审的文案表。
 * 旧版满屏工程术语（合并阈值 / 空闲阈值 / 锁屏媒体处理 / 强制模式 /
 * 静默自启 / 调度方式 / 循环时间），全部换成人话。
 */

export const S = {
  // 中文名「缓缓」，英文名 Hold On。界面里只用中文名，英文名跟在这句后面当副标。
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
  addTime: '加一个时间',
  timePlaceholder: '例如 22:00',
  taskMode: '提醒方式',
  modeFocusHint: '桌面中间弹一个小窗，点确认才消失',
  modeLockHint: '全屏强制休息，中途退不出去',
  taskLockDuration: '休息多久',
  taskPreNotify: '提前几秒提醒',
  taskSnooze: '可以推迟几分钟',
  taskMaxSnooze: '最多推迟几次',
  deleteTask: '删除这个提醒',
  deleteTaskConfirm: title => `删除「${title}」？这个操作撤不回来。`,
  newTaskTitle: '新提醒',
  minutes: '分钟',
  seconds: '秒',
  hours: '小时',
  times: '次',

  // 休息时长超过这道线，往大改就要验指纹 —— 见 actions.js 的 applyDuration。
  // 这是自律工具里唯一一处"加码需要授权"的地方：临时起意把 30 分钟改成
  // 3 小时（或者反过来事后偷偷改短）都该是一次有意识的动作。
  durationAuthHint: '超过 10 分钟要按指纹或输密码',

  /* ---- 设置页 ---- */
  settingsTitle: '设置',
  groupBreak: '强制休息',
  groupGeneral: '声音与启动',
  groupLook: '外观',
  groupAbout: '关于',

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
  lockSnoozeLeft: n => `还能推迟 ${n} 次`,
  lockEmergency: '紧急情况，需要继续用电脑',
  lockGateTitle: '输入下面这段文字来解除',

  /* ---- 闸门 ---- */
  gateHint: '这是故意做得很难的出口。粘不上，只能一个字一个字敲。',
  gateProgress: (matched, total) => `已输入 ${matched} / ${total}`,
  gateWrong: '这里跟上面不一样',
  gatePass: '对上了，可以解除',
  gateDone: '解除休息',
  gateWaiting: '还没输完',

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
  toastBadTime: '时间格式不对，像 22:00 这样写',
  toastDupeTime: '这个时间已经加过了',
};

/** 内置任务的标题与说明。用户改过之后就用用户自己的。 */
export const BUILTIN = {
  sit: { title: '久坐提醒', desc: '站起来活动一下，别连着坐太久' },
  water: { title: '喝水提醒', desc: '去接杯水，顺便走两步' },
  eye: { title: '护眼提醒', desc: '看看远处，让眼睛歇一会儿' },
};

export const BUILTIN_IDS = Object.keys(BUILTIN);

export function taskTitle(task) {
  if (!task) return '';
  if (task.title) return task.title;
  return BUILTIN[task.id]?.title || S.newTaskTitle;
}

export function taskDesc(task) {
  if (!task) return '';
  if (task.desc) return task.desc;
  return BUILTIN[task.id]?.desc || '';
}
