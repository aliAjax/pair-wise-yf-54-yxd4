import { defineStore } from 'pinia';
import {
  BREACH_LIMIT,
  RECOVERY_LIMIT,
  VersionConflictError,
  evaluateCondition,
  mergeReading,
  reviewFor,
  type ConditionReport,
  type KeeperReview,
  type Reading,
  type ReadingInput
} from '../services/conditions';

export type Stage = 'arrival' | 'install' | 'return';
export type CheckStatus = 'pending' | 'passed' | 'issue';
export interface Exhibit {
  id: string;
  code: string;
  name: string;
  lender: string;
  hall: string;
  stage: Stage;
  status: CheckStatus;
  signed: string[];
  environment: { temperature: number; humidity: number; light: number };
}
export interface Discrepancy { id: string; exhibitId: string; title: string; severity: 'minor' | 'major'; resolved: boolean; }
interface State {
  exhibits: Exhibit[];
  discrepancies: Discrepancy[];
  queued: number;
  /** 每个展柜按采集时刻归位的读数序列。 */
  readings: Record<string, Reading[]>;
  /** 每个展柜读数序列的乐观锁版本，每次入库 +1。 */
  versions: Record<string, number>;
  /** 保管员复核记录（被新读数作废后保留为审计痕迹，判定时自动失效）。 */
  reviews: Record<string, KeeperReview | null>;
}

const seedBase = {
  exhibits: Array.from({ length: 24 }, (_, index) => ({
    id: `ex-${index + 1}`,
    code: `M${String(index + 1).padStart(3, '0')}`,
    name: ['青铜镜', '釉里红瓷瓶', '石雕佛首', '手抄经卷', '鎏金香炉'][index % 5] + ` ${index + 1}`,
    lender: index % 2 ? '西北博物馆' : '私人借展方',
    hall: index % 3 === 0 ? 'A2 温湿展柜' : 'B1 开放展区',
    stage: (index < 8 ? 'arrival' : index < 18 ? 'install' : 'return') as Stage,
    status: index === 4 ? ('issue' as const) : index < 10 ? ('passed' as const) : ('pending' as const),
    signed: index < 5 ? ['保管员', '借展方'] : index < 10 ? ['保管员'] : [],
    environment: { temperature: 20 + index % 3, humidity: 48 + index % 8, light: 120 + index * 3 }
  })),
  discrepancies: [
    { id: 'd1', exhibitId: 'ex-5', title: '封条编号与交接单不一致', severity: 'major' as const, resolved: false },
    { id: 'd2', exhibitId: 'ex-7', title: '木箱边角轻微磕碰', severity: 'minor' as const, resolved: false }
  ]
};

function seed(): State {
  const now = Date.now();
  const readings: Record<string, Reading[]> = {};
  const versions: Record<string, number> = {};
  const reviews: Record<string, KeeperReview | null> = {};
  seedBase.exhibits.forEach((exhibit) => {
    // 既有快照迁移为一条合格基线读数，所有展柜从「正常」开始。
    readings[exhibit.id] = [{ collectedAt: now - 3600_000, receivedAt: now - 3600_000, ...exhibit.environment }];
    versions[exhibit.id] = 0;
    reviews[exhibit.id] = null;
  });
  return { ...seedBase, queued: 0, readings, versions, reviews };
}

const STORAGE_KEY = 'yf54-exhibition-state';
export { STORAGE_KEY };

function load(): State {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return seed();
  const parsed = JSON.parse(saved) as Partial<State> & State;
  // 兼容旧版本存档：补齐读数序列与版本字段。
  if (!parsed.readings || !parsed.versions) return { ...seed(), exhibits: parsed.exhibits, discrepancies: parsed.discrepancies, queued: parsed.queued ?? 0 };
  if (!parsed.reviews) parsed.reviews = {};
  for (const exhibit of parsed.exhibits) {
    parsed.reviews[exhibit.id] ??= null;
  }
  return parsed;
}

export interface ReadingSubmission {
  baseVersion: number;
  reading: ReadingInput;
}

export const useExhibitionStore = defineStore('exhibition', {
  state: () => load(),
  getters: {
    unresolved: (state) => state.discrepancies.filter((item) => !item.resolved).length,
    stageCounts: (state) => ({ arrival: state.exhibits.filter((item) => item.stage === 'arrival').length, install: state.exhibits.filter((item) => item.stage === 'install').length, return: state.exhibits.filter((item) => item.stage === 'return').length }),
    /** 结论永远基于完整读数序列现算：任何新读数入库后旧结论自动作废重算。 */
    conditionOf: (state) => (exhibitId: string): ConditionReport =>
      evaluateCondition(state.readings[exhibitId] ?? [], state.reviews[exhibitId] ?? null)
  },
  actions: {
    persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.$state)); },
    markQueued() { this.queued += 1; this.persist(); },
    /**
     * 终端提交一条读数。须携带打开展柜时读到的基线版本号；
     * 期间另一终端已提交时版本落后 → VersionConflictError，本次不入库。
     */
    submitReading(exhibitId: string, payload: ReadingSubmission): { replaced: boolean; version: number } {
      const current = this.versions[exhibitId] ?? 0;
      if (payload.baseVersion !== current) {
        throw new VersionConflictError(payload.baseVersion, current);
      }
      const incoming: Reading = { ...payload.reading, receivedAt: Date.now() };
      const { readings, replaced } = mergeReading(this.readings[exhibitId] ?? [], incoming);
      this.readings[exhibitId] = readings;
      this.versions[exhibitId] = current + 1;
      const exhibit = this.exhibits.find((item) => item.id === exhibitId);
      if (exhibit) {
        exhibit.environment = { temperature: incoming.temperature, humidity: incoming.humidity, light: incoming.light };
      }
      this.markQueued();
      return { replaced, version: current + 1 };
    },
    /** 待复核状态下，保管员确认恢复正常；不满足条件返回 false。 */
    confirmReview(exhibitId: string, keeper = '保管员'): boolean {
      const currentVersion = this.versions[exhibitId] ?? 0;
      const review = reviewFor(this.readings[exhibitId] ?? [], keeper, currentVersion);
      if (!review) return false;
      this.reviews[exhibitId] = review;
      this.persist();
      return true;
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
      const id = `ex-${Date.now()}`;
      this.exhibits.unshift({ id, ...payload, stage: 'arrival', status: 'pending', signed: [], environment: { temperature: 20, humidity: 50, light: 150 } });
      this.readings[id] = [{ collectedAt: Date.now(), receivedAt: Date.now(), temperature: 20, humidity: 50, light: 150 }];
      this.versions[id] = 0;
      this.reviews[id] = null;
      this.markQueued();
    },
    syncQueue() { this.queued = 0; this.persist(); }
  }
});

export { BREACH_LIMIT, RECOVERY_LIMIT, VersionConflictError };
