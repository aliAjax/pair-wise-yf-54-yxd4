<script setup lang="ts">
import { computed, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { api } from './services/api';
import { useExhibitionStore, readingOutOfBounds, VersionConflictError, type CheckStatus, type Exhibit } from './stores/exhibition';

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

const statusMeta: Record<CheckStatus, { label: string; color: string }> = {
  pending: { label: '待核验', color: 'grey' },
  passed: { label: '通过', color: 'green' },
  issue: { label: '异常', color: 'red' },
  review: { label: '待复核', color: 'orange' }
};

// ---- 读数提交对话框 ----
const readingDialog = ref(false);
const readingTarget = ref<Exhibit | null>(null);
const baseVersion = ref(0);
const conflict = ref('');
const readingForm = ref({ temperature: 22, humidity: 55, light: 180, collectedAt: '' });

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openReading(item: Exhibit) {
  readingTarget.value = item;
  baseVersion.value = item.version;
  conflict.value = '';
  readingForm.value = {
    temperature: item.environment.temperature,
    humidity: item.environment.humidity,
    light: item.environment.light,
    collectedAt: toLocalInput(new Date())
  };
  readingDialog.value = true;
}

function submitReading() {
  if (!readingTarget.value) return;
  const collectedAt = readingForm.value.collectedAt ? new Date(readingForm.value.collectedAt).getTime() : Date.now();
  try {
    store.submitReading(
      readingTarget.value.id,
      { temperature: Number(readingForm.value.temperature), humidity: Number(readingForm.value.humidity), light: Number(readingForm.value.light), collectedAt },
      baseVersion.value
    );
    conflict.value = '';
    baseVersion.value = readingTarget.value.version;
  } catch (error) {
    if (error instanceof VersionConflictError) conflict.value = error.message;
    else throw error;
  }
}

/** 模拟另一终端抢先提交同一展柜读数：当前版本号 +1，本终端基线过期 */
function simulateOtherTerminal() {
  if (!readingTarget.value) return;
  const item = readingTarget.value;
  store.submitReading(
    item.id,
    { temperature: item.environment.temperature, humidity: item.environment.humidity, light: item.environment.light, collectedAt: Date.now() },
    item.version
  );
}

function formatTime(ts: number) { return new Date(ts).toLocaleString('zh-CN'); }
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
                      <v-chip size="small" :color="statusMeta[item.status].color">{{ statusMeta[item.status].label }}</v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-virtual-scroll>
            </v-window-item>
            <v-window-item value="environment">
              <v-table>
                <thead><tr><th>展品</th><th>温度</th><th>湿度</th><th>照度</th><th>版本</th><th>条件</th><th>操作</th></tr></thead>
                <tbody><tr v-for="item in store.exhibits" :key="item.id">
                  <td>{{ item.code }}</td>
                  <td>{{ item.environment.temperature }}℃</td>
                  <td>{{ item.environment.humidity }}%</td>
                  <td>{{ item.environment.light }} lux</td>
                  <td class="text-caption">v{{ item.version }}</td>
                  <td><v-chip size="small" :color="statusMeta[item.status].color">{{ statusMeta[item.status].label }}</v-chip></td>
                  <td>
                    <v-btn size="small" color="deep-purple" variant="text" @click="openReading(item)">记录读数</v-btn>
                    <v-btn v-if="item.status === 'review'" size="small" color="orange" variant="text" @click="store.reviewRecovery(item.id)">保管员复核</v-btn>
                  </td>
                </tr></tbody>
              </v-table>
              <div class="pa-4 text-caption text-medium-emphasis">
                判定规则：同一展柜连续 3 次越界才置异常，单点抖动只记一笔；恢复需连续 2 次正常并经保管员复核。阈值：温度 18–24℃、湿度 45–65%、照度 ≤300 lux。
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

        <v-dialog v-model="readingDialog" max-width="640">
          <v-card v-if="readingTarget" :title="`记录读数 · ${readingTarget.code}`">
            <v-card-text>
              <v-alert v-if="conflict" type="error" icon="mdi-alert-circle" class="mb-3">{{ conflict }}</v-alert>
              <v-row>
                <v-col cols="3"><v-text-field v-model.number="readingForm.temperature" label="温度 ℃" type="number" /></v-col>
                <v-col cols="3"><v-text-field v-model.number="readingForm.humidity" label="湿度 %" type="number" /></v-col>
                <v-col cols="3"><v-text-field v-model.number="readingForm.light" label="照度 lux" type="number" /></v-col>
                <v-col cols="3"><v-text-field v-model="readingForm.collectedAt" label="采集时刻" type="datetime-local" /></v-col>
              </v-row>
              <div class="d-flex align-center ga-2">
                <v-btn color="deep-purple" @click="submitReading">提交读数（基于 v{{ baseVersion }}）</v-btn>
                <v-btn variant="text" color="secondary" @click="simulateOtherTerminal">模拟另一终端提交</v-btn>
              </div>
              <div class="text-caption text-medium-emphasis mt-2">同一展柜连续 3 次越界判异常；单点抖动只记一笔；恢复需连续 2 次正常并经保管员复核。</div>
              <v-list density="compact" class="mt-3">
                <v-list-item v-for="r in store.readingsByExhibit(readingTarget.id)" :key="r.id">
                  <template #prepend><v-icon :color="readingOutOfBounds(r) ? 'red' : 'green'">{{ readingOutOfBounds(r) ? 'mdi-alert-circle' : 'mdi-check-circle' }}</v-icon></template>
                  <v-list-item-title>{{ formatTime(r.collectedAt) }} · {{ r.temperature }}℃ / {{ r.humidity }}% / {{ r.light }} lux</v-list-item-title>
                  <v-list-item-subtitle>{{ readingOutOfBounds(r) ? '越界' : '正常' }}</v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </v-card-text>
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
      </v-container>
    </v-main>
  </v-app>
</template>

<style>
.metric-label { color: #6b7280; font-size: 13px; }
.metric { font-size: 31px; font-weight: 750; color: #4c1d95; }
.metric.warn { color: #b91c1c; }
.exhibit-row { border-bottom: 1px solid #eee; cursor: pointer; }
</style>
