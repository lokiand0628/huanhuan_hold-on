/**
 * 对外的链接，只此一处。
 *
 * 仓库地址散在 api.js（检查更新）、mock.js（模拟响应）和设置页（关于作者）三处，
 * 改名或换账号时漏掉任何一处都是"点了没反应"或者"更新永远检查不到"，
 * 而这两种毛病都不会报错。所以让它们全部从这里取。
 */

const SLUG = 'lokiand0628/huanhuan_hold-on';

export const LINKS = {
  /** 项目主页。GitHub 上的 star 按钮就在这里，所以"快捷标星"也开这个。 */
  repo: `https://github.com/${SLUG}`,
  /** release 列表。检查更新发现有新版时把人送到这儿。 */
  releases: `https://github.com/${SLUG}/releases`,
  /** 作者主页 */
  author: 'https://github.com/lokiand0628',
};

/** GitHub API 用的 `owner/repo`，和上面几个 URL 派生出同一个仓库 */
export const REPO_SLUG = SLUG;
