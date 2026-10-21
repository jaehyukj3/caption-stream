import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('./views/HomeView.vue') },
    { path: '/host', component: () => import('./views/HostView.vue') },
    { path: '/view/:code', component: () => import('./views/ViewerView.vue'), props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
