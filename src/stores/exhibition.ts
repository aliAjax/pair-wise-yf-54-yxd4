import { defineStore } from 'pinia';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue' | 'review';

export interface Reading {
  id: string;
  exhibitId: string;
  /** 采集时刻（毫秒），读数按此刻度入库、归位 */
  collectedAt: number;
  temperature: number;
  humidity: number;
  light: number;
}

export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  /** 乐观锁版本号：每次读数提交成功后 +1 */
  version: number;
  environment: { temperature: number; humidity: number; light: number };
}

export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean; }
interface State { exhibits: Exhibit[]; discrepancies: Discrepancy[]; readings: Reading[]; queued: number; }

/** 展柜越界阈值：温度 18–24℃，湿度 45–65%，照度 ≤300 lux */
export const READING_THRESHOLDS = {
  temperature: { min: 18, max: 24 },
  humidity: { min: 45, max: 65 },
  light: { max: 300 }
} as const;

export function readingOutOfBounds(reading: Pick<Reading, 'temperature' | 'humidity' | 'light'>): boolean {
  return reading.temperature < READING_THRESHOLDS.temperature.min
    || reading.temperature > READING_THRESHOLDS.temperature.max
    || reading.humidity < READING_THRESHOLDS.humidity.min
    || reading.humidity > READING_THRESHOLDS.humidity.max
    || reading.light > READING_THRESHOLDS.light.max;
}

/** 两个终端同时提交同一展柜读数时，后到的一方看到版本冲突 */
export class VersionConflictError extends Error {
  constructor(public readonly currentVersion: number, public readonly baseVersion: number) {
    super(`读数版本冲突：当前为 v${currentVersion}，您基于 v${baseVersion} 提交，请刷新后重试`);
    this.name = 'VersionConflictError';
  }
}

function makeExhibits(): Exhibit[] {
  return Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: index < 8 ? 'arrival' : index < 18 ? 'install' : 'return',
    status: index === 4 ? 'issue' : index < 10 ? 'passed' : 'pending',
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    version: 0,
    environment: index === 4
      ? { temperature: 26, humidity: 72, light: 420 }
      : { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  }));
}

function makeReadings(exhibits: Exhibit[]): Reading[] {
  return exhibits.flatMap((exhibit, index) => {
    const oob = exhibit.status === 'issue';
    const count = oob ? 3 : 2;
    return Array.from({ length: count }, (_, k) => ({
      id: `rd-${exhibit.id}-${k}`,
      exhibitId: exhibit.id,
      collectedAt: Date.now() - (count - k) * 3600_000 - index * 60_000,
      temperature: oob ? 26 : exhibit.environment.temperature,
      humidity: oob ? 72 : exhibit.environment.humidity,
      light: oob ? 420 : exhibit.environment.light
    }));
  });
}

const exhibits = makeExhibits();
const seed: State = {
  exhibits,
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major', resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor', resolved: false }
  ],
  readings: makeReadings(exhibits),
  queued: 0
};

function load(): State {
  const saved = localStorage.getItem('yf54-exhibition-state');
  if (!saved) return seed;
  const parsed = JSON.parse(saved) as Partial<State>;
  return {
    exhibits: (parsed.exhibits ?? seed.exhibits).map((exhibit) => ({ ...exhibit, version: exhibit.version ?? 0 })),
    discrepancies: parsed.discrepancies ?? seed.discrepancies,
    readings: parsed.readings ?? seed.readings,
    queued: parsed.queued ?? 0
  };
}

/**
 * 按连续读数重算展品条件：
 * - 同一展柜连续 3 次及以上越界 → 异常（issue）
 * - 异常后连续 2 次及以上正常 → 待保管员复核（review），复核后才通过
 * - 单点抖动只记一笔，不改变已有结论
 */
function recomputeStatus(readings: Reading[], exhibitId: string, previous: CheckStatus): CheckStatus {
  const list = readings
    .filter((reading) => reading.exhibitId === exhibitId)
    .sort((a, b) => a.collectedAt - b.collectedAt);
  if (list.length === 0) return previous;
  const lastOob = readingOutOfBounds(list[list.length - 1]);
  let run = 1;
  for (let i = list.length - 2; i >= 0; i -= 1) {
    if (readingOutOfBounds(list[i]) === lastOob) run += 1;
    else break;
  }
  if (lastOob && run >= 3) return 'issue';
  if (!lastOob && run >= 2 && (previous === 'issue' || previous === 'review')) return 'review';
  return previous;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length }),
    readingsByExhibit: (state) => (id: string) =>
      state.readings
        .filter((reading) => reading.exhibitId === id)
        .sort((a, b) => a.collectedAt - b.collectedAt)
  },
  actions: {
    persist() { localStorage.setItem('yf54-exhibition-state', JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    /**
     * 提交一条展柜读数（模拟服务端乐观锁）。
     * @param baseVersion 提交方看到的版本号；与当前版本不一致时抛 VersionConflictError
     */
    submitReading(id: string, input: { temperature: number; humidity: number; light: number; collectedAt?: number }, baseVersion: number) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit) throw new Error('展品不存在');
      if (exhibit.version !== baseVersion) throw new VersionConflictError(exhibit.version, baseVersion);

      const collectedAt = input.collectedAt ?? Date.now();
      const reading: Reading = {
        id: `rd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        exhibitId: id,
        collectedAt,
        temperature: input.temperature,
        humidity: input.humidity,
        light: input.light
      };
      // 同一采集时刻重复的只留一条（覆盖旧值），读数始终按采集时刻归位
      const duplicate = this.readings.findIndex((item) => item.exhibitId === id && item.collectedAt === collectedAt);
      if (duplicate >= 0) this.readings[duplicate] = reading;
      else this.readings.push(reading);

      // 最新读数（按采集时刻）回写到展品当前环境
      const latest = this.readings
        .filter((item) => item.exhibitId === id)
        .sort((a, b) => b.collectedAt - a.collectedAt)[0];
      exhibit.environment = { temperature: latest.temperature, humidity: latest.humidity, light: latest.light };

      // 新读数作废已通过的结论，按全部读数重算
      exhibit.status = recomputeStatus(this.readings, id, exhibit.status);
      exhibit.version += 1;
      this.markQueued();
    },
    /** 保管员复核恢复：只有待复核状态可以复核通过 */
    reviewRecovery(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (exhibit && exhibit.status === 'review') {
        exhibit.status = 'passed';
        this.markQueued();
      }
    },
    sign(id: string, role: string) { const exhibit = this.exhibits.find((item) => item.id === id); if (!exhibit || exhibit.signed.includes(role)) return; exhibit.signed.push(role); this.markQueued(); },
    advance(id: string) {
      const exhibit = this.exhibits.find((item) => item.id === id);
      if (!exhibit || !exhibit.signed.includes('借展方') || this.discrepancies.some((item) => item.exhibitId === id && !item.resolved)) return;
      exhibit.stage = exhibit.stage === 'arrival' ? 'install' : exhibit.stage === 'install' ? 'return' : 'return';
      this.markQueued();
    },
    resolveDiscrepancy(id: string) { const item = this.discrepancies.find((entry) => entry.id === id); if (item) { item.resolved = true; this.markQueued(); } },
    addExhibit(payload: Pick<Exhibit, 'code' | 'name' | 'lender' | 'hall'>) {
      this.exhibits.unshift({ id: `ex-${Date.now()}`, ...payload, stage: 'arrival', status: 'pending', signed: [], version: 0, environment: { temperature: 20, humidity: 50, light: 150 } });
      this.markQueued();
    },
    syncQueue() { this.queued = 0; this.persist(); }
  }
});
