// vitest/config의 defineConfig를 사용해야 test 옵션이 타입 체크를 통과함
// Use defineConfig from vitest/config so the `test` option is typed.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 개발 서버의 /api 호출을 FastAPI 백엔드로 프록시
    // Proxy /api calls to the FastAPI backend during development.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  test: {
    environment: 'jsdom',
    // @testing-library/react의 자동 cleanup은 전역 afterEach가 있을 때만 등록된다.
    // globals가 false면 컴포넌트 테스트끼리 DOM이 누적되어 조용히 서로를 오염시킨다.
    // @testing-library/react only registers its auto-cleanup when a global afterEach exists; with
    // globals disabled the DOM accumulates across component tests and they silently pollute each other.
    globals: true,
  },
})
