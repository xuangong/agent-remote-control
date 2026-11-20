import type { AreaMessages } from '../types.js';
import type { hosts as english } from './hosts.en.js';

export const hosts: AreaMessages<typeof english> = {
  'hosts.sessionNoun': { other: '个会话' },
  'hosts.sessionsWorking': '{count} 个在忙',
  'hosts.sessionsNeedYou': '{count} 个需要你',
  'hosts.sessionsIdle': '{count} 个空闲',
  'hosts.sessionsFailed': '{count} 个出错',
  'hosts.cores': { other: '{count} 核' },
  'hosts.memory': '内存',
  'hosts.home': '主目录',
  'hosts.disk': '{name} 磁盘',
  'hosts.updateSharedOwner': '需要更新：这个 Controller 要由所有者先更新，会话才能打开。',
  'hosts.updateDsh': '需要更新：要先在那台机器上更新它的 DSH agent-remote 插件，这里才能发送或打开会话。',
  'hosts.updateControllerBefore': '需要更新：这个 Controller 更新之前，这里没法发送或打开会话。点「更新」，或者在那台机器上运行 ',
  'hosts.updateControllerAfter': ' 并按提示操作。',
  'hosts.updateAction': '更新',
  'hosts.sharedNeedsUpdate': '所有者更新 Controller 之后，会话才会显示出来。',
  'hosts.needsUpdateToSee': '更新 Controller 后，才能看到 CPU、内存和磁盘。',
  'hosts.sharedSessionsOnly': '别人分享给你的：只能看会话。',
  'hosts.statusUnavailable': '暂时看不到状态。',
  'hosts.empty': '还没有配对的电脑，配对之后会显示在这里。',
};
