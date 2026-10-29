// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

const repo = 'https://github.com/burnzy1148/agent-typewriter';
const site = 'https://agent-typewriter.com';
const bannerAlt = "Agent Typewriter: watch your agent's edits replayed as if a human were typing them";

export default defineConfig({
  site,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Agent Typewriter',
      description: "Watch your agent's edits replayed in VS Code as if a human were typing them.",
      logo: { src: './src/assets/icon.png', alt: '' },
      favicon: '/images/icon.png',
      social: [
        { icon: 'github', label: 'GitHub', href: repo },
        {
          icon: 'vscode',
          label: 'Visual Studio Code Marketplace',
          href: 'https://marketplace.visualstudio.com/items?itemName=burnzy1148.agent-typewriter',
        },
      ],
      editLink: { baseUrl: `${repo}/edit/develop/site/` },
      // The Marketplace banner doubles as the link preview image (iMessage, Slack, social posts).
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: `${site}/images/banner.png` } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1280' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '640' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: bannerAlt } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${site}/images/banner.png` } },
        { tag: 'meta', attrs: { name: 'twitter:image:alt', content: bannerAlt } },
      ],
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: 'Getting started', link: '/docs/getting-started/' },
        { label: 'How it works', link: '/docs/how-it-works/' },
        { label: 'Highlights', link: '/docs/highlights/' },
        { label: 'The panels', link: '/docs/panels/' },
        { label: 'Session files', link: '/docs/session-files/' },
        { label: 'Replaying git history', link: '/docs/git-history/' },
        {
          label: 'Filtering',
          items: [
            { label: 'Filters', link: '/docs/filtering/' },
            { label: 'Repository settings file', link: '/docs/repository-settings/' },
            { label: 'Filter profiles', link: '/docs/filter-profiles/' },
            { label: 'Worktrees', link: '/docs/worktrees/' },
            { label: 'Lanes', link: '/docs/lanes/' },
          ],
        },
        { label: 'Settings', link: '/docs/settings/' },
        { label: 'Limits', link: '/docs/limits/' },
      ],
    }),
  ],
  vite: {
    // The landing page and the settings reference read the extension's package.json.
    server: { fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  },
});
