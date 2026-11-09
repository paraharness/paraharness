import { defineConfig } from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

/**
 * Normalizes generated TypeDoc sidebar items to clean VitePress URLs.
 */
const apiSidebarItems = typedocSidebar.map((item) => ({
  text: item.text,
  link: item.link.replace(/\.md$/, ''),
}));

export default defineConfig({
  title: 'Paraharness',
  description: 'Declarative multi-agent orchestration and durable execution for TypeScript',
  base: '/paraharness/',
  outDir: '../docs-dist',
  cleanUrls: true,
  vite: {
    build: {
      chunkSizeWarningLimit: 2000,
    },
  },
  themeConfig: {
    search: {
      provider: 'local',
    },
    outline: {
      level: [2, 3],
      label: 'On this page',
    },
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '^/guide/' },
      { text: 'Packages', link: '/packages/core', activeMatch: '^/packages/' },
      { text: 'API Reference', link: '/api/@paraharness/core', activeMatch: '^/api/' },
      { text: 'npm', link: 'https://www.npmjs.com/org/paraharness' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
        ],
      },
      {
        text: 'Packages',
        items: [
          {
            text: 'Core & Lockfile',
            items: [
              { text: '@paraharness/core', link: '/packages/core' },
              { text: '@paraharness/lockfile', link: '/packages/lockfile' },
            ],
          },
          {
            text: 'Model Drivers',
            items: [
              { text: '@paraharness/claude', link: '/packages/claude' },
              { text: '@paraharness/openai', link: '/packages/openai' },
              { text: '@paraharness/gemini', link: '/packages/gemini' },
            ],
          },
          {
            text: 'Execution & Sandboxing',
            items: [
              { text: '@paraharness/git', link: '/packages/git' },
              { text: '@paraharness/fs', link: '/packages/fs' },
              { text: '@paraharness/node', link: '/packages/node' },
              { text: '@paraharness/markdown', link: '/packages/markdown' },
            ],
          },
          {
            text: 'Storage & Connectors',
            items: [
              { text: '@paraharness/sqlite', link: '/packages/sqlite' },
              { text: '@paraharness/postgres', link: '/packages/postgres' },
              { text: '@paraharness/github', link: '/packages/github' },
              { text: '@paraharness/slack', link: '/packages/slack' },
            ],
          },
        ],
      },
      {
        text: 'API Reference',
        items: [
          { text: 'Overview', link: '/api/' },
          ...apiSidebarItems,
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/paraharness/paraharness' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Tornike Tsomaia',
    },
  },
});
