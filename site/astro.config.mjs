// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

const repo = 'https://github.com/burnzy1148/agent-typewriter';

export default defineConfig({
  site: 'https://agent-typewriter.com',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'Agent Typewriter',
      description: "Watch your agent's edits replayed in VS Code as if a person were typing them.",
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
