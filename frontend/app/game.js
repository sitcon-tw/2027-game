export const phaseNames = { before: '活動前', active: '進行中', ended: '已結束' };
export const roleNames = { user: '一般玩家', staff: '工作人員', booth: '攤位人員' };
export const boothNames = {
  'booth-1': '1 · SITCON 社群交流', 'booth-2': '2 · 開源 Demo', 'booth-3': '3 · 活動組任務',
};
export const inventoryNames = {
  coins: '金幣', points: '對戰積分', packs: '卡包', peekCards: '透視卡', hintCredits: '提示次數',
  scissors: '剪刀卡', rock: '石頭卡', paper: '布卡', wild: '萬用卡',
};
const cardOrder = ['scissors', 'rock', 'paper', 'wild'];
export const planetNames = Object.fromEntries(
  ['太陽', '地球', '水星', '火星', '土星', '月球'].flatMap((series, group) =>
    ['綠', '粉', '橘', '黃', '淺藍', '深藍', '紫'].map((color, index) =>
      [`planet:${group * 7 + index}`, `${series} · ${color}`])),
);

export function inventoryQuantity(player, resource) {
  if (!player) return null;
  if (Object.hasOwn(planetNames, resource)) {
    return Array.isArray(player.ownedPlanets) ? Number(player.ownedPlanets.includes(Number(resource.slice(7)))) : null;
  }
  const index = cardOrder.indexOf(resource);
  return (index === -1 ? player[resource] : player.hand?.[index]) ?? null;
}
export const parameters = [
  ['randomEggPrice', '隨機蛋價格', 1, 3600],
  ['seriesEggPrice', '星球蛋價格', 1, 3600],
  ['hintThreshold', '打卡提示門檻', 1, 3600],
  ['missionCoins', '每項任務金幣', 0, 3600],
  ['agendaPacks', '每次議程卡包', 1, 3],
  ['battleWinCoins', '對戰勝利金幣', 0, 3600],
  ['battleDrawCoins', '對戰平手金幣', 0, 3600],
  ['battleCooldownSeconds', '對戰冷卻秒數', 1, 3600],
];

const numberFormat = new Intl.NumberFormat('zh-TW');
const timeFormat = new Intl.DateTimeFormat('zh-TW', { dateStyle: 'short', timeStyle: 'medium', hour12: false });
export const count = (value) => Array.isArray(value) ? value.length : typeof value === 'number' ? value : 0;
export const number = (value) => numberFormat.format(count(value));
export const nameOf = (names, value) => Object.hasOwn(names, value) ? names[value] : value ?? '—';

export function time(value) {
  if (!value) return '尚無紀錄';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : timeFormat.format(date);
}

const numericFields = new Set(['amount', 'expected', 'packs', 'limit', 'remaining', 'checkpointNumber', ...parameters.map(([name]) => name)]);

export function actionPayload(action, form) {
  const args = {};
  for (const [key, value] of new FormData(form)) args[key] = numericFields.has(key) ? Number(value) : value.trim();
  if (action === 'role' && args.role !== 'booth') delete args.boothId;
  if (action === 'station') args.open = form.elements.open.checked;
  if (action === 'adjustInventory') {
    args.delta = args.direction === 'revoke' ? -args.amount : args.amount;
    delete args.amount;
    delete args.direction;
  }
  return { action, args };
}

export function confirmationFor({ action, args }, state) {
  if (action === 'adjustInventory') {
    const player = state?.players.find(({ id }) => id === args.playerId);
    const label = inventoryNames[args.resource] ?? planetNames[args.resource];
    const submit = args.delta < 0 ? '收回' : '發放';
    return {
      title: `確認${submit}？`,
      detail: `${player?.name || args.playerId}（${args.playerId}）· ${label}：${number(args.expected)} → ${number(args.expected + args.delta)}；原因：${args.reason}`,
      submit: `確認${submit}`,
    };
  }
  if (action === 'replaceBadge') {
    const player = state?.players.find(({ id }) => id === args.playerId);
    const uid = args.uid.replace(/[ :\-]/g, '').toUpperCase();
    return {
      title: '確認名牌綁定？',
      detail: `${player?.name || args.playerId}（${args.playerId}）：${args.expectedUid || '未綁定'} → ${uid}`,
      submit: '確認綁定',
    };
  }
  if (action === 'phase' && args.phase === 'ended') {
    return { title: '結束測試活動？', detail: '此變更會影響所有玩家的活動操作，不會刪除資料。', submit: '結束活動' };
  }
  if (action === 'agenda') {
    return { title: '確認全體議程發包？', detail: `時段 ${args.slot}：發送給所有已報到玩家，每人 ${state?.parameters?.agendaPacks ?? '依目前參數'} 包。相同時段不重複發送。`, submit: '確認發包' };
  }
  if (action === 'remotePacks' && args.playerId === 'all') {
    return { title: '確認全體卡包獎勵？', detail: `發送給所有已報到玩家，每人 ${args.amount} 包。投遞識別碼：${args.deliveryId}；原因：${args.reason}。相同識別碼只投遞一次。`, submit: '確認發送' };
  }
}
