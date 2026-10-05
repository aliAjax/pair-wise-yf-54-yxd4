<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { METRIC_LIMITS, metricBreaches, VersionConflictError } from './services/conditions';
import { STORAGE_KEY, useExhibitionStore, type Exhibit } from './stores/exhibition';

const store = useExhibitionStore();
const online = useOnline();
const tab = ref<'checkin' | 'environment' | 'discrepancy'>('checkin');
const dialog = ref(false);
const selected = ref<Exhibit | null>(null);
const schema = toTypedSchema(z.object({ code: z.string().min(2), name: z.string().min(2), lender: z.string().min(2), hall: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [code] = defineField('code');
const [name] = defineField('name');
const [lender] = defineField('lender');
const [hall] = defineField('hall');
const apiLabel = computed(() => String(api.defaults.baseURL));

const submit = handleSubmit((values) => { store.addExhibit(values); dialog.value = false; resetForm(); });
function stageLabel(stage: Exhibit['stage']) { return { arrival: '到场点交', install: '布展核验', return: '闭展归还' }[stage]; }

// ---------- 读数上报（乐观锁） ----------
const readingDialog = ref(false);
const readingTarget = ref<Exhibit | null>(null);
const baseVersion = ref(0);
const rTemp = ref(20);
const rHumidity = ref(50);
const rLight = ref(150);
const rCollectedAt = ref('');
const readError = ref('');
const snack = ref('');
const snackVisible = ref(false);
function showSnack(message: string) { snack.value = message; snackVisible.value = true; }

const readingReport = computed(() => (readingTarget.value ? store.conditionOf(readingTarget.value.id) : null));

function pad2(n: number) { return String(n).padStart(2, '0'); }
function toLocalInput(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtTime(ts: number) { return new Date(ts).toLocaleString('zh-CN', { hour12: false }); }

function openReading(exhibit: Exhibit) {
  readingTarget.value = exhibit;
  refreshBaseline();
  readError.value = '';
  readingDialog.value = true;
}
function refreshBaseline() {
  const exhibit = readingTarget.value;
  if (!exhibit) return;
  const report = store.conditionOf(exhibit.id);
  baseVersion.value = store.versions[exhibit.id] ?? 0;
  const last = report.last;
  rTemp.value = last?.temperature ?? exhibit.environment.temperature;
  rHumidity.value = last?.humidity ?? exhibit.environment.humidity;
  rLight.value = last?.light ?? exhibit.environment.light;
  rCollectedAt.value = toLocalInput(Date.now());
  readError.value = '';
}
function submitReading() {
  const exhibit = readingTarget.value;
  if (!exhibit) return;
  const collectedAt = new Date(rCollectedAt.value).getTime();
  if (Number.isNaN(collectedAt)) { readError.value = '采集时刻格式不正确'; return; }
  try {
    const { replaced } = store.submitReading(exhibit.id, {
      baseVersion: baseVersion.value,
      reading: { collectedAt, temperature: Number(rTemp.value), humidity: Number(rHumidity.value), light: Number(rLight.value) }
    });
    snack.value = replaced ? '同一采集时刻读数已覆盖，结论已重算' : '读数已按采集时刻入库，结论已重算';
    readingDialog.value = false;
    snackVisible.value = true;
  } catch (err) {
    if (err instanceof VersionConflictError) {
      readError.value = `${err.message}。请点「读入最新版本」后重新提交，勿覆盖对方读数。`;
    } else {
      readError.value = err instanceof Error ? err.message : String(err);
    }
  }
}
function confirmReview(exhibitId: string) {
  if (store.confirmReview(exhibitId)) showSnack('保管员已复核，展品条件恢复正常');
  else showSnack('当前不是待复核状态，无法复核');
}

// 两个终端（标签页）同时操作：另一标签页写入后同步本地 store，便于现场演示版本冲突。
function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY && event.newValue) {
    try { store.$patch(JSON.parse(event.newValue)); } catch { /* 忽略坏数据 */ }
  }
}
onMounted(() => window.addEventListener('storage', onStorage));
onUnmounted(() => window.removeEventListener('storage', onStorage));

const conditionMeta: Record<string, { color: string; label: string }> = {
  normal: { color: 'green', label: '正常' },
  abnormal: { color: 'red', label: '异常' },
  recovering: { color: 'orange', label: '恢复中' },
  pendingReview: { color: 'amber-darken-2', label: '待复核' }
};
function metricLabel(key: 'temperature' | 'humidity' | 'light') {
  return { temperature: '温度', humidity: '湿度', light: '照度' }[key];
}
function metricUnit(key: 'temperature' | 'humidity' | 'light') {
  return { temperature: '℃', humidity: '%', light: ' lux' }[key];
}
const limits = METRIC_LIMITS;
</script>

<template>
  <v-app>
    <v-app-bar color="deep-purple-darken-3" flat>
      <v-app-bar-title>{{ $t('title') }}</v-app-bar-title>
      <v-chip class="mr-3" :color="online ? 'green' : 'orange'" theme="dark">{{ online ? '在线' : '离线暂存' }}</v-chip>
      <v-btn prepend-icon="mdi-plus" @click="dialog = true">登记展品</v-btn>
    </v-app-bar>
    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-6">
        <v-alert v-if="!online || store.queued" color="orange-lighten-4" icon="mdi-cloud-off-outline" class="mb-5">
          网络不可用时核验不会丢失：当前有 {{ store.queued }} 条变更在本地队列。接口地址 {{ apiLabel }}
          <template #append><v-btn v-if="online" variant="text" @click="store.syncQueue">确认同步</v-btn></template>
        </v-alert>

        <v-row class="mb-5">
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">待到场点交</div><div class="metric">{{ store.stageCounts.arrival }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">布展中</div><div class="metric">{{ store.stageCounts.install }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">未解决差异</div><div class="metric warn">{{ store.unresolved }}</div></v-card-text></v-card></v-col>
          <v-col cols="12" md="3"><v-card><v-card-text><div class="metric-label">本地待同步</div><div class="metric">{{ store.queued }}</div></v-card-text></v-card></v-col>
        </v-row>

        <v-card>
          <v-tabs v-model="tab" color="deep-purple">
            <v-tab value="checkin">{{ $t('checkIn') }}</v-tab><v-tab value="environment">{{ $t('environment') }}</v-tab><v-tab value="discrepancy">{{ $t('discrepancies') }}</v-tab>
          </v-tabs>
          <v-window v-model="tab">
            <v-window-item value="checkin">
              <v-virtual-scroll :items="store.exhibits" height="520" item-height="112">
                <template #default="{ item }">
                  <v-list-item :key="item.id" class="exhibit-row" @click="selected = item">
                    <template #prepend><v-avatar color="deep-purple-lighten-4">{{ item.code.slice(1) }}</v-avatar></template>
                    <v-list-item-title>{{ item.name }} · {{ item.code }}</v-list-item-title>
                    <v-list-item-subtitle>{{ item.lender }} · {{ item.hall }} · {{ stageLabel(item.stage) }}</v-list-item-subtitle>
                    <template #append>
                      <v-chip size="small" class="mr-2" :color="item.status === 'issue' ? 'red' : item.status === 'passed' ? 'green' : 'grey'">{{ item.status }}</v-chip>
                      <v-chip size="small" :color="conditionMeta[store.conditionOf(item.id).status].color">
                        环境{{ conditionMeta[store.conditionOf(item.id).status].label }}
                      </v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-alert type="info" variant="tonal" density="compact" class="ma-3">
                判定规则：温/湿/照度任一越限即为越界读数；同展柜<b>连续 3 次越界</b>才置异常，单次抖动只记账不改结论；
                异常后<b>连续 2 次合格</b>进入待复核，经<b>保管员复核</b>才恢复正常。读数按采集时刻去重归位，新读数入库后结论全部重算。
              </v-alert>
              <v-table>
                <thead>
                  <tr><th>展品/柜位</th><th>最新读数（采集时刻）</th><th>越界连续</th><th>合格连续</th><th>抖动</th><th>条件</th><th>操作</th></tr>
                </thead>
                <tbody>
                  <tr v-for="item in store.exhibits" :key="item.id">
                    <td>{{ item.code }}<div class="text-caption">{{ item.hall }}</div></td>
                    <td>
                      <span v-for="b in store.conditionOf(item.id).lastBreaches" :key="b.metric" class="breach-badge">
                        {{ metricLabel(b.metric) }}{{ b.direction === 'high' ? '↑' : '↓' }}{{ b.value }}{{ metricUnit(b.metric) }}
                      </span>
                      <template v-if="store.conditionOf(item.id).lastBreaches.length === 0">
                        {{ item.environment.temperature }}℃ / {{ item.environment.humidity }}% / {{ item.environment.light }} lux
                      </template>
                      <div class="text-caption">{{ store.conditionOf(item.id).last ? fmtTime(store.conditionOf(item.id).last!.collectedAt) : '—' }}</div>
                    </td>
                    <td>
                      <v-chip size="small" :color="store.conditionOf(item.id).consecutiveBreaches >= 3 ? 'red' : 'grey'">
                        {{ store.conditionOf(item.id).consecutiveBreaches }} / 3
                      </v-chip>
                    </td>
                    <td>
                      <v-chip size="small" :color="store.conditionOf(item.id).consecutiveInRange >= 2 ? 'green' : 'grey'">
                        {{ store.conditionOf(item.id).consecutiveInRange }} / 2
                      </v-chip>
                    </td>
                    <td>
                      <v-chip size="small" :color="store.conditionOf(item.id).blips.length ? 'orange' : 'grey'">
                        {{ store.conditionOf(item.id).blips.length }} 笔
                      </v-chip>
                    </td>
                    <td>
                      <v-chip size="small" :color="conditionMeta[store.conditionOf(item.id).status].color">
                        {{ conditionMeta[store.conditionOf(item.id).status].label }}
                        <template v-if="store.conditionOf(item.id).status === 'recovering'">
                          {{ store.conditionOf(item.id).consecutiveInRange }}/2
                        </template>
                      </v-chip>
                      <div v-if="store.conditionOf(item.id).reviewApplied" class="text-caption text-green">
                        经{{ store.conditionOf(item.id).review?.keeper }}复核恢复
                      </div>
                      <div v-if="store.conditionOf(item.id).reviewInvalid" class="text-caption text-red">
                        复核已被新读数作废，重算中
                      </div>
                    </td>
                    <td>
                      <v-btn size="small" variant="outlined" prepend-icon="mdi-clipboard-plus-outline" @click="openReading(item)">上报读数</v-btn>
                      <v-btn
                        v-if="store.conditionOf(item.id).status === 'pendingReview'"
                        size="small" color="green" class="ml-2"
                        prepend-icon="mdi-account-check-outline"
                        @click="confirmReview(item.id)"
                      >保管员复核恢复</v-btn>
                    </td>
                  </tr>
                </tbody>
              </v-table>
              <div class="text-caption pa-3 text-grey">
                限值参考：温度 {{ limits.temperature.min }}–{{ limits.temperature.max }}℃，
                湿度 {{ limits.humidity.min }}–{{ limits.humidity.max }}%，
                照度 ≤ {{ limits.light.max }} lux。
              </div>
            </v-window-item>
            <v-window-item value="discrepancy">
              <v-list><v-list-item v-for="item in store.discrepancies" :key="item.id"><v-list-item-title>{{ item.title }}</v-list-item-title><v-list-item-subtitle>展品 {{ item.exhibitId }} · {{ item.severity === 'major' ? '重大差异' : '轻微差异' }}</v-list-item-subtitle><template #append><v-btn :disabled="item.resolved" color="green" @click="store.resolveDiscrepancy(item.id)">{{ item.resolved ? '已解决' : '确认解决' }}</v-btn></template></v-list-item></v-list>
            </v-window-item>
          </v-window>
        </v-card>

        <v-dialog v-model="dialog" max-width="560">
          <v-card title="登记新展品">
            <v-card-text><v-form @submit.prevent="submit"><v-text-field v-model="code" label="展品编号" :error-messages="errors.code" /><v-text-field v-model="name" label="展品名称" :error-messages="errors.name" /><v-text-field v-model="lender" label="借展方" :error-messages="errors.lender" /><v-text-field v-model="hall" label="展厅/柜位" :error-messages="errors.hall" /><v-btn type="submit" color="deep-purple" block>写入点交队列</v-btn></v-form></v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog :model-value="Boolean(selected)" max-width="680" @update:model-value="selected = null">
          <v-card v-if="selected" :title="`${selected.code} · ${selected.name}`">
            <v-card-text>
              <v-timeline side="end" density="compact">
                <v-timeline-item dot-color="green"><b>保管员点收</b><p>核对包装、封条和附件清单。</p><v-btn size="small" :disabled="selected.signed.includes('保管员')" @click="store.sign(selected.id, '保管员')">{{ selected.signed.includes('保管员') ? '已签字' : '保管员签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="orange"><b>借展方确认</b><p>确认差异项及后续责任。</p><v-btn size="small" :disabled="selected.signed.includes('借展方')" @click="store.sign(selected.id, '借展方')">{{ selected.signed.includes('借展方') ? '已签字' : '借展方签字' }}</v-btn></v-timeline-item>
                <v-timeline-item dot-color="purple"><b>推进阶段</b><p>存在未解决差异或缺少借展方签字时不能推进。</p><v-btn size="small" color="deep-purple" @click="store.advance(selected.id)">推进到下一阶段</v-btn></v-timeline-item>
              </v-timeline>
            </v-card-text>
          </v-card>
        </v-dialog>

        <v-dialog v-model="readingDialog" max-width="720" @update:model-value="(v: boolean) => { if (!v) readError = ''; }">
          <v-card v-if="readingTarget">
            <v-card-title>
              上报读数 · {{ readingTarget.code }} {{ readingTarget.name }}
              <v-chip size="small" class="ml-2" :color="conditionMeta[store.conditionOf(readingTarget.id).status].color">
                {{ conditionMeta[store.conditionOf(readingTarget.id).status].label }}
              </v-chip>
            </v-card-title>
            <v-card-text>
              <v-alert color="primary" variant="tonal" density="compact" class="mb-3">
                本次提交基于展柜版本 <b>v{{ baseVersion }}</b>（当前 v{{ store.versions[readingTarget.id] ?? 0 }}）。
                若另一终端已先行上报，提交将收到版本冲突，请重读后再提交。
              </v-alert>
              <v-alert v-if="readError" type="error" density="compact" class="mb-3" title="提交被拒绝">
                {{ readError }}
                <template #append>
                  <v-btn v-if="readError.includes('版本冲突')" size="small" variant="tonal" @click="refreshBaseline">读入最新版本</v-btn>
                </template>
              </v-alert>
              <v-row dense>
                <v-col cols="6" md="3"><v-text-field v-model.number="rTemp" type="number" label="温度 ℃" :suffix="`限值 ${limits.temperature.min}–${limits.temperature.max}`" hide-details="auto" /></v-col>
                <v-col cols="6" md="3"><v-text-field v-model.number="rHumidity" type="number" label="湿度 %" :suffix="`限值 ${limits.humidity.min}–${limits.humidity.max}`" hide-details="auto" /></v-col>
                <v-col cols="6" md="3"><v-text-field v-model.number="rLight" type="number" label="照度 lux" :suffix="`限值 ≤ ${limits.light.max}`" hide-details="auto" /></v-col>
                <v-col cols="6" md="3"><v-text-field v-model="rCollectedAt" type="datetime-local" label="采集时刻" hide-details="auto" /></v-col>
              </v-row>

              <div class="text-subtitle-2 mt-4">近期读数（按采集时刻，最新在上）</div>
              <v-sheet border rounded class="reading-log">
                <div v-for="r in [...(store.readings[readingTarget.id] ?? [])].reverse().slice(0, 12)" :key="r.collectedAt" class="reading-line">
                  <v-chip size="x-small" :color="metricBreaches(r).length ? 'red' : 'green'" class="mr-2">
                    {{ metricBreaches(r).length ? '越界' : '合格' }}
                  </v-chip>
                  <span class="text-caption mr-2">{{ fmtTime(r.collectedAt) }}</span>
                  <span :class="{ 'text-red': metricBreaches(r).some((b) => b.metric === 'temperature') }">{{ r.temperature }}℃</span> /
                  <span :class="{ 'text-red': metricBreaches(r).some((b) => b.metric === 'humidity') }">{{ r.humidity }}%</span> /
                  <span :class="{ 'text-red': metricBreaches(r).some((b) => b.metric === 'light') }">{{ r.light }} lux</span>
                  <span v-if="r.receivedAt - r.collectedAt > 60000" class="text-caption text-orange ml-2">
                    （乱序补传，晚到 {{ Math.round((r.receivedAt - r.collectedAt) / 60000) }} 分钟）
                  </span>
                </div>
                <div v-if="!(store.readings[readingTarget.id] ?? []).length" class="text-caption pa-2">暂无读数</div>
              </v-sheet>
              <div v-if="readingReport?.blips.length" class="text-caption text-orange-darken-2 mt-2">
                单点抖动 {{ readingReport.blips.length }} 笔（已记账，未改变结论）：
                {{ readingReport.blips.map((b) => fmtTime(b.collectedAt) + ' ' + b.breaches.map((x) => metricLabel(x.metric)).join('/')).join('；') }}
              </div>
            </v-card-text>
            <v-card-actions>
              <v-spacer />
              <v-btn variant="text" @click="readingDialog = false">取消</v-btn>
              <v-btn color="deep-purple" prepend-icon="mdi-send" @click="submitReading">提交读数（v{{ baseVersion }}）</v-btn>
            </v-card-actions>
          </v-card>
        </v-dialog>

        <v-snackbar v-model="snackVisible" :timeout="2600" color="green">{{ snack }}</v-snackbar>
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
.breach-badge {
  display: inline-block; margin-right: 4px; padding: 0 6px; border-radius: 8px;
  background: #ffebee; color: #c62828; font-size: 12px;
}
.reading-log { max-height: 220px; overflow: auto; }
.reading-line { padding: 4px 10px; border-bottom: 1px dashed #e0e0e0; font-size: 13px; }
.reading-line:last-child { border-bottom: none; }
</style>
