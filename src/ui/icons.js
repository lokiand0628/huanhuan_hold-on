/**
 * 图标集：24×24 网格，2px 描边、圆头圆角。
 *
 * 任务图标来自 Lucide（ISC 许可，上游 lucide-static v1.54.0），这里存的是从官方
 * SVG 里抽出来的内部图形字符串 —— 没有任何运行时依赖，动态库一个字节都不加。
 * 它的网格和描边规范恰好和本项目原本定的完全一致：
 *   viewBox 0 0 24 24 / fill none / stroke currentColor / stroke-width 2 / 圆头圆角
 * 外层属性由 dom.js 的 svg() 统一给，所以这里只留内部图形。
 *
 * 为什么把任务图标从手绘换成 Lucide：
 *   旧的那四个（人、水滴、眼睛、闪光）是分开画的，视觉重量对不齐 —— 水滴饱满、
 *   人形纤细、闪光偏小，摆进选择器就是那种"说不上哪里不对但一眼就不对"。
 *   Lucide 是在同一张网格上按同一套几何规则画的，天然一致，18px 下也还认得出。
 *
 * 颜色 = 分类，不是每个图标一种颜色。24 个图标归到现有的四个身份色上，
 * 选图标就自动得到颜色，用户不用再挑一次色；规范的"配色取少不取多"也要求颜色封顶。
 *
 * 为什么不用文字首字（更早的版本是拿标题第一个字当图标）：
 *   - 中文取一个字、英文取一个字母，同一张卡片在两种语言下长得完全不一样
 *   - 用户改一次标题，图标就跟着变，看起来像坏了
 */
import { svg } from './dom.js';

const ICONS = {
  /* ==================== 任务图标（Lucide，ISC） ==================== */

  /* ---- Macaw 蓝 · 作息与活动 ---- */
  sunrise:
    '<path d="M12 2v8" /><path d="m4.93 10.93 1.41 1.41" /><path d="M2 18h2" /><path d="M20 18h2" /><path d="m19.07 10.93-1.41 1.41" /><path d="M22 22H2" /><path d="m8 6 4-4 4 4" /><path d="M16 18a4 4 0 0 0-8 0" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />',
  // 走动：门开着，人往外走。比原来那个脚印清楚得多 —— 脚印 18px 下就是一团墨点
  'door-open':
    '<path d="M10 21H2" /><path d="M10 3H7a2 2 0 00-2 2v16" /><path d="M14 12h.01" /><path d="M19 21V5a2 2 0 00-1.675-1.974l-6.163-1.013A1 1 0 0010 3v18a1 1 0 001.124.992z" /><path d="M22 21h-3" />',
  'person-standing':
    '<circle cx="12" cy="5" r="1" /><path d="m9 20 3-6 3 6" /><path d="m6 8 6 2 6-2" /><path d="M12 10v4" />',
  flame:
    '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" />',
  // 秒表。任务图标和"计时"共用这一个名字，所以下面界面区里不再单独定义一个 timer
  timer:
    '<line x1="10" x2="14" y1="2" y2="2" /><line x1="12" x2="15" y1="14" y2="11" /><circle cx="12" cy="14" r="8" />',

  /* ---- Owl 绿 · 入口与身体 ---- */
  'glass-water':
    '<path d="M5.116 4.104A1 1 0 0 1 6.11 3h11.78a1 1 0 0 1 .994 1.105L17.19 20.21A2 2 0 0 1 15.2 22H8.8a2 2 0 0 1-2-1.79z" /><path d="M6 12a5 5 0 0 1 6 0 5 5 0 0 0 6 0" />',
  milk: '<path d="M8 2h8" /><path d="M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2" /><path d="M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0" />',
  apple:
    '<path d="M12 6.528V3a1 1 0 0 1 1-1h0" /><path d="M18.237 21A15 15 0 0 0 22 11a6 6 0 0 0-10-4.472A6 6 0 0 0 2 11a15.1 15.1 0 0 0 3.763 10 3 3 0 0 0 3.648.648 5.5 5.5 0 0 1 5.178 0A3 3 0 0 0 18.237 21" />',
  salad:
    '<path d="M19.496 12a2.5 2.5 0 00.399-2.214A2 2 0 0020.32 6.5 2 2 0 0019 3a2 2 0 00-1.5.68 2 2 0 00-3.287.424 2.5 2.5 0 00-3.189 2.06A3 3 0 0012 12l4-4" /><path d="M4 12a1 1 0 00-.99 1.133A9 9 0 0012 21a9 9 0 008.99-7.867A1 1 0 0020 12z" /><path d="M7 21h10" /><path d="M9.85 6.907A3.5 3.5 0 005.05 12" />',
  utensils:
    '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" /><path d="M7 2v20" /><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />',
  pill: '<path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" /><path d="m8.5 8.5 7 7" />',
  coffee:
    '<path d="M10 2v2" /><path d="M14 2v2" /><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" /><path d="M6 2v2" />',
  bath: '<path d="M10 4 8 6" /><path d="M17 19v2" /><path d="M2 12h20" /><path d="M7 19v2" /><path d="M9 5 7.621 3.621A2.121 2.121 0 0 0 4 5v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />',

  /* ---- Fox 橙 · 休息与感官 ---- */
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
  wind: '<path d="M12.8 19.6A2 2 0 1 0 14 16H2" /><path d="M17.5 8a2.5 2.5 0 1 1 2 4H2" /><path d="M9.8 4.4A2 2 0 1 1 11 8H2" />',
  brain:
    '<path d="M12 18V5" /><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" /><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" /><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" /><path d="M18 18a4 4 0 0 0 2-7.464" /><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" /><path d="M6 18a4 4 0 0 1-2-7.464" /><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />',
  moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
  'moon-star':
    '<path d="M18 5h4" /><path d="M20 3v4" /><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />',
  bed: '<path d="M2 4v16" /><path d="M2 8h18a2 2 0 0 1 2 2v10" /><path d="M2 17h20" /><path d="M6 8v9" />',

  /* ---- Betta 紫 · 其它 ---- */
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />',
  'heart-pulse':
    '<path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5" /><path d="M3.22 13H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />',
  smile:
    '<path d="M15 10V9" /><path d="M16.472 15a6 6 0 01-8.943 0" /><path d="M9 10V9" /><circle cx="12" cy="12" r="10" />',
  sparkles:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" /><path d="M20 2v4" /><path d="M22 4h-4" /><circle cx="4" cy="20" r="2" />',

  /* ==================== 界面图标 ==================== */
  /* 这几个是照同一套网格手绘的，用量小、形态简单，暂时不换成 Lucide。
     没有引用的一律删掉了 —— 留着只会让人以为它们在用。 */
  bell: '<path d="M18 8.6a6 6 0 1 0-12 0c0 4.2-1.4 5.4-1.4 5.4h14.8S18 12.8 18 8.6z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  sliders:
    '<path d="M4 6.5h5"/><path d="M15 6.5h5"/><circle cx="12" cy="6.5" r="2.1"/><path d="M4 12h9"/><path d="M19 12h1"/><circle cx="16" cy="12" r="2.1"/><path d="M4 17.5h1"/><path d="M11 17.5h9"/><circle cx="8" cy="17.5" r="2.1"/>',
  clock: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>',
  chevron: '<path d="M6.5 9.5l5.5 5.5 5.5-5.5"/>',
  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.8h5V7"/><path d="M6.6 7l.9 12.2h9l.9-12.2"/>',
  image:
    '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3.2"/><circle cx="8.8" cy="9.6" r="1.7"/><path d="M3.9 16.4l4.6-4.2 3.4 3 3.2-2.8 4.6 4"/>',
  volume:
    '<path d="M4.5 9.5h3.2L12 6v12l-4.3-3.5H4.5z"/><path d="M15.6 9.4a3.6 3.6 0 0 1 0 5.2"/><path d="M18.2 6.8a7.2 7.2 0 0 1 0 10.4"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4"/><path d="M12 7.8v.1"/>',
  refresh: '<path d="M19.4 12a7.4 7.4 0 1 1-2.2-5.3"/><path d="M19.6 3.9v4.2h-4.2"/>',
  check: '<path d="M4.8 12.6l4.8 4.8L19.2 7.6"/>',
  shield: '<path d="M12 3.2l7 2.9v5.6c0 4.4-2.9 7.4-7 9.1-4.1-1.7-7-4.7-7-9.1V6.1l7-2.9z"/>',
  play: '<path d="M8.6 5.8l9 6.2-9 6.2z"/>',
  pause: '<path d="M9.4 5.6v12.8"/><path d="M14.6 5.6v12.8"/>',
};

/* ==================== 任务图标的分组与颜色 ==================== */

/**
 * 四个身份色 → 该色下的图标。数组顺序就是选择器里的显示顺序。
 * color 用的是 components.css 里已有的 [data-id-color="..."] 那四个名字，没有新增颜色。
 */
export const TASK_ICON_GROUPS = [
  { color: 'sit', icons: ['sunrise', 'sun', 'door-open', 'person-standing', 'flame', 'timer'] },
  {
    color: 'water',
    icons: ['glass-water', 'milk', 'apple', 'salad', 'utensils', 'pill', 'coffee', 'bath'],
  },
  { color: 'eye', icons: ['eye', 'wind', 'brain', 'moon', 'moon-star', 'bed'] },
  { color: 'custom', icons: ['hand', 'heart-pulse', 'smile', 'sparkles'] },
];

export const TASK_ICONS = TASK_ICON_GROUPS.flatMap(group => group.icons);

/** 中文名。只当 aria-label 用，界面上不显示 —— 图标本身就该自解释。 */
export const TASK_ICON_LABELS = {
  sunrise: '早起',
  sun: '晒太阳',
  'door-open': '出门走动',
  'person-standing': '起身',
  flame: '运动',
  timer: '番茄钟',
  'glass-water': '喝水',
  milk: '牛奶',
  apple: '水果',
  salad: '轻食',
  utensils: '吃饭',
  pill: '吃药',
  coffee: '咖啡',
  bath: '洗澡',
  eye: '护眼',
  wind: '深呼吸',
  brain: '放空',
  moon: '睡觉',
  'moon-star': '早睡',
  bed: '上床',
  hand: '手部',
  'heart-pulse': '心率',
  smile: '心情',
  sparkles: '自定义',
};

/** 图标 → 身份色。反查表，由上面的分组生成，别手工维护第二份。 */
const ICON_COLOR = {};
for (const group of TASK_ICON_GROUPS) {
  for (const name of group.icons) ICON_COLOR[name] = group.color;
}

/**
 * 老配置里存的是这四个名字（`icon` 字段更早还叫过 `tone`）。
 * 名字换了，老数据不能炸，也**不能静默变成"自定义"** —— 那会让用户所有旧任务
 * 一夜之间都变成同一个紫色闪光，看着像数据丢了。
 */
const LEGACY_TASK_ICONS = {
  sit: 'person-standing',
  water: 'glass-water',
  eye: 'eye',
  custom: 'sparkles',
};

/** 老名字清单。store.js 迁移配置时要用它判断"这个值是不是历史遗留"。 */
export const LEGACY_ICON_NAMES = Object.keys(LEGACY_TASK_ICONS);

/** 任意写法（新名 / 老名）→ 当前集合里的名字；不认识就返回 null，交给调用方兜底 */
export function normalizeIconName(name) {
  const mapped = LEGACY_TASK_ICONS[name] || name;
  return ICON_COLOR[mapped] ? mapped : null;
}

/**
 * 图标属于哪个身份色。老名字也认 —— 老配置直接喂进来不会退回默认紫。
 * 认不出就退回 custom，宁可颜色不对也不要抛错。
 */
export function colorForIcon(name) {
  const mapped = LEGACY_TASK_ICONS[name] || name;
  return ICON_COLOR[mapped] || 'custom';
}

/**
 * 任务该用哪个图标。
 *
 * 顺序很重要：先看用户选过的 `icon`，没有再按内置任务的 id 推断，
 * 都没有才是"自定义"。内置任务（久坐/喝水/护眼）老配置里没有 `icon` 字段，
 * 靠 id 推断才能拿到对的图标，而不是一水儿的闪光。
 */
export function iconForTask(task) {
  return normalizeIconName(task?.icon) || normalizeIconName(task?.id) || 'sparkles';
}

/* ==================== 应用标记 ==================== */

/**
 * 「缓缓」的标记：两根圆角竖条，也就是暂停符号 —— Hold On 的字面形状。
 *
 * 同一个形状有两种装法：
 *   界面里（这里）—— 透明底、只有图形本身，颜色跟随 currentColor
 *   Dock / 启动台   —— 套一个蓝色圆角方块，就是 src-tauri/icons 里那套
 * Dock 那个必须是方块，系统不认透明形状；界面里这个必须是透明的，
 * 套了框就成了一个缩小的图标，很土。
 *
 * 为什么不走 icon()：图标集是描边式的（stroke 2px），而这个标记是**填充**形状。
 * 被描边一撑，两根竖条中间的缝就没了，糊成一块。
 */
const LOGO_MARK =
  '<rect x="6.2" y="5" width="4.6" height="14" rx="2.3" />' +
  '<rect x="13.2" y="5" width="4.6" height="14" rx="2.3" />';

export function logoMark(size = 24) {
  return svg(LOGO_MARK, { size, fill: 'currentColor', stroke: 'none' });
}

/* ==================== 渲染 ==================== */

const warned = new Set();

export function icon(name, opts) {
  const markup = ICONS[name];
  if (!markup && !warned.has(name)) {
    warned.add(name);
    // 名字写错不该静默变成另一个图标 —— 那样得盯着屏幕找半天。
    // 每个名字只抱怨一次，免得每秒重绘刷满控制台。
    console.warn(`[icons] 没有这个图标：${name}，已回退成 sparkles`);
  }
  return svg(markup || ICONS.sparkles, opts);
}
