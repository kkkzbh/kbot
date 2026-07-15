<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useSessionStore } from '@/stores/session';

const accessToken = ref('');
const loading = ref(false);
const session = useSessionStore();
const route = useRoute();
const router = useRouter();

async function submit() {
  if (!accessToken.value) return;
  loading.value = true;
  try {
    await session.login(accessToken.value);
    await router.replace(typeof route.query.redirect === 'string' ? route.query.redirect : '/');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-card">
      <div class="login-brand"><span>Q</span><strong>QQBot Admin</strong></div>
      <p class="eyebrow">INDEPENDENT OPERATIONS</p>
      <h1>运维工作台</h1>
      <p class="login-description">首次使用服务器配置的 Admin access token 登录后，浏览器会通过 HttpOnly Cookie 保持会话，并在每次打开管理台时自动续期。</p>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item label="Access token">
          <el-input v-model="accessToken" type="password" show-password size="large" autocomplete="current-password" @keyup.enter="submit" />
        </el-form-item>
        <el-button type="primary" size="large" :loading="loading" :disabled="!accessToken" style="width:100%" @click="submit">进入工作台</el-button>
      </el-form>
      <p class="login-security">90 天滚动续期 · HttpOnly · SameSite Strict · Origin protected</p>
    </section>
  </main>
</template>

<style scoped>
.login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 20% 10%, #25375f 0, #121a2a 35%, #0c111c 100%); }
.login-card { width: min(430px, 100%); padding: 38px; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; color: #dce3ef; background: rgba(20,29,45,.94); box-shadow: 0 30px 80px rgba(0,0,0,.3); }
.login-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 34px; }
.login-brand span { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 9px; color: #fff; background: #486de0; font-weight: 800; }
.login-brand strong { font-size: 13px; }
.eyebrow { margin: 0 0 5px; color: #75819a; font-size: 9px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 0; color: #fff; font-size: 29px; letter-spacing: -.03em; }
.login-description { margin: 10px 0 28px; color: #929db1; font-size: 12px; line-height: 1.7; }
.login-security { margin: 22px 0 0; color: #677287; font-size: 9px; text-align: center; }
:deep(.el-form-item__label) { color: #aeb8c8; }
</style>
