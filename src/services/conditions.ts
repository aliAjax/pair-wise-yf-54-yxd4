/**
 * 展柜环境读数与展品条件判定 —— 纯领域逻辑（不依赖 Pinia / DOM，便于单测）。
 *
 * 运维约定：
 * 1. 温度、湿度、照度任一项越出限值，该读数即记为一次「越界读数」。
 * 2. 同一展柜连续 3 次越界读数，展品条件才置为「异常」；
 *    单次抖动只在抖动账上记一笔，不改变条件结论。
 * 3. 异常后需连续 2 次合格读数进入「待复核」，再经保管员复核才恢复「正常」；
 *    恢复期内一旦再越界，连续合格计数清零，回到「异常」。
 * 4. 读数按采集时刻入库：同一采集时刻重复上报只留一条（后到覆盖），
 *    乱序到达按采集时刻归位。任何新读数入库后，结论一律基于完整序列重算，
 *    不缓存「已通过」。
 * 5. 保管员复核的是「截至某采集时刻的整段读数序列」：该序列签名未变，复核才
 *    持续有效（事件闭合，后续健康读数维持正常）；补传/覆盖改动了被复核序列，
 *    复核立即作废并按新序列重算。
 * 6. 提交读数须携带终端基线版本号（乐观锁）：与柜位当前版本不一致即抛出版本
 *    冲突，后到终端必须重读最新读数后重新提交。
 */

export interface MetricRange { min: number; max: number }
export interface MetricLimits {
  temperature: MetricRange;
  humidity: MetricRange;
  light: MetricRange;
}

/** 展柜环境限值（如馆方标准调整，只改这里）。 */
export const METRIC_LIMITS: MetricLimits = {
  temperature: { min: 15, max: 25 }, // ℃
  humidity: { min: 40, max: 65 },    // %RH
  light: { min: 0, max: 200 }        // lux
};

export interface Reading {
  collectedAt: number; // 采集时刻（epoch ms）
  receivedAt: number;  // 入库时刻（epoch ms）
  temperature: number;
  humidity: number;
  light: number;
}

export type ReadingInput = Pick<Reading, 'collectedAt' | 'temperature' | 'humidity' | 'light'>;

export type MetricKey = 'temperature' | 'humidity' | 'light';
export interface Breach {
  metric: MetricKey;
  value: number;
  limit: number;
  direction: 'high' | 'low';
}

/** 正常：合格；异常：连续 3 次越界；恢复中：异常后已连续合格 1 次；待复核：已连续合格 2 次。 */
export type ConditionStatus = 'normal' | 'abnormal' | 'recovering' | 'pendingReview';

export interface Blip {
  collectedAt: number;
  breaches: Breach[];
}

export interface KeeperReview {
  reviewedAt: number;
  keeper: string;
  /** 复核时的读数版本（审计展示用）。 */
  version: number;
  /** 被复核序列的最后一个采集时刻。 */
  upToCollectedAt: number;
  /** 被复核序列内容签名：补传/覆盖改动到该前缀即判复核作废。 */
  prefixSignature: string;
}

export interface ConditionReport {
  status: ConditionStatus;
  consecutiveBreaches: number; // 末尾连续越界读数（展示用）
  consecutiveInRange: number;  // 末尾连续合格读数（展示用）
  blips: Blip[];               // 序列中的全部单点抖动
  last: Reading | null;
  lastBreaches: Breach[];
  total: number;
  review: KeeperReview | null;
  reviewApplied: boolean;      // 复核闭合当前仍成立（条件因此为正常）
  reviewInvalid: boolean;      // 复核记录被新入库数据作废
}

export const BREACH_LIMIT = 3;
export const RECOVERY_LIMIT = 2;

/** 两个终端并发提交同一展柜读数时，基线版本落后的一方收到此错误。 */
export class VersionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`版本冲突：提交基于版本 v${expected}，该展柜当前已是 v${actual}`);
    this.name = 'VersionConflictError';
  }
}

export function metricBreaches(reading: ReadingInput, limits: MetricLimits = METRIC_LIMITS): Breach[] {
  const out: Breach[] = [];
  const check = (metric: MetricKey, value: number, range: MetricRange): void => {
    if (value > range.max) out.push({ metric, value, limit: range.max, direction: 'high' });
    else if (value < range.min) out.push({ metric, value, limit: range.min, direction: 'low' });
  };
  check('temperature', reading.temperature, limits.temperature);
  check('humidity', reading.humidity, limits.humidity);
  check('light', reading.light, limits.light);
  return out;
}

const byCollectedAt = (a: Reading, b: Reading): number => a.collectedAt - b.collectedAt;

/** 新读数入库：同一采集时刻只留一条（后到覆盖），乱序按采集时刻归位。 */
export function mergeReading(readings: Reading[], incoming: Reading): { readings: Reading[]; replaced: boolean } {
  const idx = readings.findIndex((item) => item.collectedAt === incoming.collectedAt);
  if (idx >= 0) {
    const next = readings.slice();
    next[idx] = incoming;
    return { readings: next.sort(byCollectedAt), replaced: true };
  }
  return { readings: [...readings, incoming].sort(byCollectedAt), replaced: false };
}

/** 序列内容签名（FNV-1a）：用于识别补传/覆盖是否改动了已复核序列。 */
function signature(readings: Reading[]): string {
  const canonical = JSON.stringify(
    readings.map((r) => [r.collectedAt, r.temperature, r.humidity, r.light])
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function evaluateCondition(
  readings: Reading[],
  review: KeeperReview | null,
  limits: MetricLimits = METRIC_LIMITS
): ConditionReport {
  const sorted = [...readings].sort(byCollectedAt);

  // 复核闭合点：仅当被复核的前缀序列与复核时完全一致时有效。
  let closureIndex = -1;
  if (review) {
    const prefix = sorted.filter((r) => r.collectedAt <= review.upToCollectedAt);
    if (prefix.length > 0 && signature(prefix) === review.prefixSignature) {
      closureIndex = prefix.length - 1;
    }
  }

  let mode: 'normal' | 'abnormal' = 'normal';
  let runBreaches = 0;
  let runInRange = 0;
  let status: ConditionStatus = 'normal';
  let closed = false;
  let pendingBlip: Blip | null = null;
  const blips: Blip[] = [];

  sorted.forEach((reading, i) => {
    const breaches = metricBreaches(reading, limits);
    if (breaches.length === 0) {
      if (mode === 'normal') {
        runBreaches = 0;
        pendingBlip = null;
      } else {
        runInRange += 1;
        status = runInRange >= RECOVERY_LIMIT ? 'pendingReview' : 'recovering';
      }
    } else if (mode === 'normal') {
      runBreaches += 1;
      if (runBreaches === 1) {
        // 先按单点抖动记一笔；若后续连成两次以上，这笔抖动账撤回（已非抖动）。
        pendingBlip = { collectedAt: reading.collectedAt, breaches };
        blips.push(pendingBlip);
      } else if (pendingBlip) {
        blips.splice(blips.indexOf(pendingBlip), 1);
        pendingBlip = null;
      }
      if (runBreaches >= BREACH_LIMIT) {
        mode = 'abnormal';
        runInRange = 0;
        status = 'abnormal';
      }
    } else {
      // 异常恢复期内再越界：连续合格计数清零。
      runInRange = 0;
      status = 'abnormal';
    }

    // 到达复核闭合点：事件经保管员复核关闭，之后读数在正常基线上继续判定。
    if (!closed && closureIndex === i && mode === 'abnormal' && runInRange >= RECOVERY_LIMIT) {
      closed = true;
      mode = 'normal';
      runBreaches = 0;
      runInRange = 0;
      pendingBlip = null;
      status = 'normal';
    }
  });

  let consecutiveBreaches = 0;
  let consecutiveInRange = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (metricBreaches(sorted[i], limits).length > 0) consecutiveBreaches += 1;
    else break;
  }
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (metricBreaches(sorted[i], limits).length === 0) consecutiveInRange += 1;
    else break;
  }

  const last = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  return {
    status,
    consecutiveBreaches,
    consecutiveInRange,
    blips,
    last,
    lastBreaches: last ? metricBreaches(last, limits) : [],
    total: sorted.length,
    review,
    reviewApplied: closed && status === 'normal',
    reviewInvalid: review !== null && closureIndex === -1
  };
}

/** 构造保管员复核记录；仅当当前结论确为「待复核」时允许，否则返回 null。 */
export function reviewFor(
  readings: Reading[],
  keeper: string,
  version: number,
  reviewedAt: number = Date.now()
): KeeperReview | null {
  const sorted = [...readings].sort(byCollectedAt);
  const last = sorted[sorted.length - 1];
  if (!last) return null;
  if (evaluateCondition(sorted, null).status !== 'pendingReview') return null;
  return {
    reviewedAt,
    keeper,
    version,
    upToCollectedAt: last.collectedAt,
    prefixSignature: signature(sorted)
  };
}
