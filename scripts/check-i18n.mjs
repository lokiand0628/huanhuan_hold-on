/**
 * 文案表的对齐检查（CI 会跑）。
 *
 * 为什么需要它：`zh` 里少写一个键、而 `en` 里有，中文界面毫无异常；反过来
 * ——`en` 里少一个键——那一块会在英文界面下**静默空白**。函数键漏掉更糟：
 * 调用处直接 TypeError。这两类问题编译期都发现不了，跑一遍才是最快的。
 *
 * 用法：node scripts/check-i18n.mjs
 */
import {
  STRINGS,
  S,
  setLanguage,
  builtinTasks,
  BUILTIN_IDS,
  taskTitle,
  taskDesc,
  languageTag,
} from '../src/core/strings.js';

const langs = Object.keys(STRINGS);
const problems = [];

if (langs.length < 2) {
  problems.push(`至少要有两种语言，现在只有：${langs.join(', ')}`);
}

const [base, ...others] = langs;
const baseKeys = Object.keys(STRINGS[base]).sort();

for (const lang of others) {
  const keys = Object.keys(STRINGS[lang]).sort();

  for (const key of baseKeys) {
    if (!keys.includes(key)) problems.push(`${lang} 缺少键 \`${key}\``);
  }
  for (const key of keys) {
    if (!baseKeys.includes(key)) problems.push(`${base} 缺少键 \`${key}\`（${lang} 里有）`);
  }

  // 键都在还不够：函数键在两边都得是函数，否则调用处会炸
  for (const key of baseKeys) {
    const a = typeof STRINGS[base][key];
    const b = typeof STRINGS[lang][key];
    if (a !== b) problems.push(`\`${key}\` 类型不一致：${base} 是 ${a}，${lang} 是 ${b}`);
    if (b === 'function') {
      // 拿假参数试调一次，只为确认它真的能调（参数个数两边可以不同）
      try {
        STRINGS[lang][key](1, 2);
      } catch (err) {
        problems.push(`\`${key}\` 在 ${lang} 里调用失败：${err.message}`);
      }
    }
  }
}

// 内置任务的标题/说明也要两边齐全，否则默认任务会显示成空的
for (const lang of langs) {
  setLanguage(lang);
  const builtin = builtinTasks();
  for (const id of BUILTIN_IDS) {
    if (!builtin[id]?.title || !builtin[id]?.desc) {
      problems.push(`内置任务 \`${id}\` 在 ${lang} 下缺标题或说明`);
    }
  }
  // 空 title/desc 的任务走 BUILTIN 兜底，这里顺带确认兜底真的生效
  const probe = { id: BUILTIN_IDS[0], title: '', desc: '' };
  if (!taskTitle(probe) || !taskDesc(probe)) {
    problems.push(`内置任务兜底在 ${lang} 下返回了空字符串`);
  }
}

if (languageTag('en') === languageTag('zh')) {
  problems.push('languageTag 对中英文返回了同一个值 —— Rust 侧会认错语言');
}

// 整片界面都是「现读 S.xxx」，所以 S 必须是**活绑定**：setLanguage 之后，
// 已经 import 过 S 的模块也要看到新表。这条断了，界面会整片停在启动时的语言
// —— 而且只有换语言那一刻才看得出来，静态检查发现不了。
setLanguage('zh');
const zhProbe = S.tabSettings;
setLanguage('en');
if (S.tabSettings === zhProbe) {
  problems.push('S 不是活绑定：setLanguage 之后旧引用还指向旧表，界面不会跟着切');
}
setLanguage('zh');

if (problems.length) {
  console.error('i18n 检查未通过：');
  for (const line of problems) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`i18n 检查通过：${langs.length} 种语言 × ${baseKeys.length} 个键，键与类型均对齐。`);
