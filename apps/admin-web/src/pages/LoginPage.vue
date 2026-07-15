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
    <form class="login-form" @submit.prevent="submit">
      <el-input
        v-model="accessToken"
        type="password"
        size="large"
        autocomplete="current-password"
        aria-label="Access token"
        placeholder="请输入Access token"
      />
      <el-button native-type="submit" type="primary" size="large" :loading="loading" :disabled="!accessToken">进入控制台</el-button>
    </form>
  </main>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #f5f7fa;
}

.login-form {
  display: grid;
  gap: 18px;
  width: min(360px, 100%);
}

.login-form :deep(.el-input__wrapper) {
  min-height: 48px;
  padding: 0 16px;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 0 0 1px #dfe3e8 inset;
}

.login-form :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #5b78e6 inset;
}

.login-form :deep(.el-input__inner::placeholder) {
  color: #a8afb9;
}

.login-form :deep(.el-button) {
  width: 100%;
  min-height: 44px;
  border-radius: 8px;
}
</style>
