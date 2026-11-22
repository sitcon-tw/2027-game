const actionErrors = new Map([
  ['badgeBindingChanged', '名牌綁定已變更，請確認目前 UID 再試。'],
  ['badgeTaken', '此 UID 已綁定其他玩家。'],
  ['notBadge', '此 UID 已保留給活動標籤，無法綁定為名牌。'],
  ['invalidUid', '請輸入有效的 7 位元組 NFC UID。'],
  ['uidReserved', '此 UID 已被使用或保留，請改用未綁定的 NTAG。'],
  ['stationNotFound', '找不到發卡站，請重新整理後再試。'],
  ['invalidInventoryAdjustment', '請選擇有效的資源與數量。'],
  ['inventoryChanged', '資源數量已變更，請更新資料後再試。'],
  ['inventoryInsufficient', '持有數量不足，無法收回。'],
  ['inventoryLimit', '超過資源持有上限。'],
  ['inventoryBattleActive', '玩家正在對戰，無法收回手牌。'],
]);

export function describeApiError(message) {
  if (typeof message === 'string' && message) return message;
  if (!message || typeof message.code !== 'string') return '操作失敗';
  if (actionErrors.has(message.code)) return actionErrors.get(message.code);
  const words = message.code.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
