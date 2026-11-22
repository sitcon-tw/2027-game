import { PlayerCard } from './service.ts';

export const selfUid = '04A1B2C3D4E5F6';
export const unknownUid = '04F00000000001';

function fixtureUid(type: string, number: number, max: number): string {
  if (!Number.isInteger(number) || number < 1 || number > max) throw new RangeError(`Expected fixture number 1–${max}`);
  return `04${type}000000000${number.toString(16).padStart(2, '0')}`.toUpperCase();
}

export const playerUid = (number: number) => fixtureUid('B', number, 18);
export const checkpointUid = (number: number) => fixtureUid('C', number, 42);
export const boothUid = (number: number) => fixtureUid('D', number, 3);
export const stationUid = (number: number) => fixtureUid('E', number, 4);

export function fixturePlayer(index: number, tags: readonly string[] = []): PlayerCard {
  return new PlayerCard({
    id: playerUid(index), name: `模擬會眾 ${String(index).padStart(2, '0')}`,
    tags, contact: '本機測試人物，非真實會眾',
  });
}

export const operatorAttendees = Object.freeze(Array.from({ length: 18 }, (_, i) => Object.freeze(fixturePlayer(i + 1))));

const checkpointAreas = [
  ['議程廳', 8], ['白板大戰', 2], ['乾爹攤位', 5], ['Demo 展攤位', 3],
  ['攤位區', 4], ['1F Welcoming Zone', 1], ['用餐區', 4], ['樓梯間', 4],
  ['移動的活動組們', 4], ['限定款', 3], ['機動', 4],
] as const;
export const checkpointAreaByIndex = Object.freeze(checkpointAreas.flatMap(([area, count]) => Array<string>(count).fill(area)));
export const checkpointByUid: ReadonlyMap<string, number> = new Map(checkpointAreaByIndex.map((_, i) => [checkpointUid(i + 1), i + 1]));
export const boothNames = ['SITCON 社群交流（模擬）', '開源 Demo（模擬）', '活動組任務（模擬）'] as const;
export const boothByUid: ReadonlyMap<string, number> = new Map(boothNames.map((_, i) => [boothUid(i + 1), i + 1]));
export const fixtureStations = Object.freeze({
  'station-1': { name: '服務台（模擬）', packs: 1, limit: 1, open: true, remaining: 100 },
  'station-2': { name: '限量走動站（模擬）', packs: 2, limit: 2, open: true, remaining: 2 },
  'station-3': { name: '未開放站（模擬）', packs: 1, limit: 1, open: false, remaining: 100 },
  'station-4': { name: '已發完站（模擬）', packs: 1, limit: 1, open: true, remaining: 0 },
});
export const stationByUid: ReadonlyMap<string, string> = new Map(Object.keys(fixtureStations).map((id, i) => [stationUid(i + 1), id]));
export const attendeeByUid: ReadonlyMap<string, PlayerCard> = new Map(operatorAttendees.map(player => [player.id, player]));
